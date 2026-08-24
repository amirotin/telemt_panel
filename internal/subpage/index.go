package subpage

import (
	"context"
	"sync"
	"time"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

// defaultRefreshInterval is how often Lookup will call Refresh again after
// a miss, per the brief ("at most once per 30s").
const defaultRefreshInterval = 30 * time.Second

// UsersLister is the subset of telemt.Client the index needs.
type UsersLister interface {
	Users(ctx context.Context) ([]telemt.UserInfo, error)
}

// Index maps subpage tokens to usernames, built from Telemt's current user
// list plus each user's stored nonce. Comparing a candidate token is a
// plain map lookup against these fixed-length (base32 of a fixed digest
// size) keys — constant-time in the sense the spec asks for: no
// byte-by-byte comparison against a secret exists on the request path,
// only a hash-map lookup.
//
// The index is not kept fresh in the background; Lookup refreshes it
// lazily on a miss, at most once every refreshInterval, so a token
// validation never blocks on a live Telemt call once the index is warm.
type Index struct {
	secret []byte
	client UsersLister
	nonces NonceProvider

	now             func() time.Time
	refreshInterval time.Duration

	mu          sync.RWMutex
	tokens      map[string]string
	lastRefresh time.Time
	// nextGen/installedGen guard against an out-of-order concurrent
	// Refresh: nextGen hands each in-flight Refresh a unique, increasing
	// sequence number when it starts; a Refresh only installs its result
	// if its number is still newer than installedGen, so a slow call that
	// started earlier can never clobber a faster one that started later
	// (see Refresh).
	nextGen      uint64
	installedGen uint64
}

// NewIndex creates an Index backed by client for the given HMAC secret.
func NewIndex(secret string, client UsersLister, nonces NonceProvider) *Index {
	return newIndex([]byte(secret), client, nonces, time.Now, defaultRefreshInterval)
}

// newIndex is the injectable-clock/interval constructor used by tests.
func newIndex(secret []byte, client UsersLister, nonces NonceProvider, now func() time.Time, refreshInterval time.Duration) *Index {
	return &Index{
		secret:          secret,
		client:          client,
		nonces:          nonces,
		now:             now,
		refreshInterval: refreshInterval,
		tokens:          make(map[string]string),
	}
}

// Lookup returns the username for token. On a miss, it refreshes the index
// from Telemt first — but only if the index hasn't refreshed within the
// last refreshInterval, so a burst of invalid guesses costs at most one
// upstream call per interval, even when many misses arrive concurrently
// (see claimRefreshWindow).
func (idx *Index) Lookup(ctx context.Context, token string) (string, bool) {
	if username, ok := idx.get(token); ok {
		return username, true
	}
	idx.TriggerRefresh(ctx)
	return idx.get(token)
}

// TriggerRefresh claims the refresh window (see claimRefreshWindow) and, if
// claimed, runs a best-effort Refresh — a failed refresh here just leaves
// the caller's own answer (a miss, or a verify-on-hit mismatch) standing.
// Lookup calls this on every miss; the public /sub/{token} handler also
// calls it when a cache hit fails re-verification against the user's
// current secret and nonce, so a stale entry left behind by a rotation
// (e.g. one whose own explicit Refresh failed) still ages out.
func (idx *Index) TriggerRefresh(ctx context.Context) {
	if idx.claimRefreshWindow() {
		_ = idx.Refresh(ctx)
	}
}

func (idx *Index) get(token string) (string, bool) {
	idx.mu.RLock()
	defer idx.mu.RUnlock()
	username, ok := idx.tokens[token]
	return username, ok
}

// claimRefreshWindow atomically checks whether a refresh is due and, if
// so, claims the window by stamping lastRefresh before returning — under
// a single lock acquisition, so "check due" and "claim it" can't be
// split by a concurrent caller the way a separate read-then-write would
// allow. Concurrent Lookup misses that lose the claim proceed straight to
// serving the (possibly still stale) map instead of also calling Refresh;
// a miss on a just-rotated token self-heals on the next window. Refresh
// itself stamps lastRefresh again once the fetch completes, which is
// harmless — it only ever extends the window further into the future.
func (idx *Index) claimRefreshWindow() bool {
	idx.mu.Lock()
	defer idx.mu.Unlock()
	if idx.now().Sub(idx.lastRefresh) < idx.refreshInterval {
		return false
	}
	idx.lastRefresh = idx.now()
	return true
}

// Refresh unconditionally rebuilds the token index from the current
// Telemt user list. Lookup already rate-limits how often it calls this on
// a miss; Refresh itself is exported and unthrottled so an admin action
// that must invalidate a token immediately — rotating a user's subpage
// nonce — can force a rebuild rather than waiting out the interval.
// Users with no extractable secret (ExtractSecret) are skipped; they
// simply have no subpage link.
//
// Concurrent Refresh calls (an explicit rotation racing the lazy
// miss-triggered path, say) can finish in any order once their Users()
// calls return. The generation number claimed at the start of this call
// fixes that: it is only installed if no call that started later has
// already installed its own — see the nextGen/installedGen fields —
// so a slow, stale call can never overwrite a newer result.
func (idx *Index) Refresh(ctx context.Context) error {
	idx.mu.Lock()
	idx.nextGen++
	gen := idx.nextGen
	idx.mu.Unlock()

	users, err := idx.client.Users(ctx)
	if err != nil {
		return err
	}

	tokens := make(map[string]string, len(users))
	for _, u := range users {
		secret, ok := ExtractSecret(u.Links)
		if !ok {
			continue
		}
		nonce, err := idx.nonces.GetSubpageNonce(u.Username)
		if err != nil {
			continue
		}
		tokens[deriveToken(idx.secret, u.Username, secret, nonce)] = u.Username
	}

	idx.mu.Lock()
	defer idx.mu.Unlock()
	idx.lastRefresh = idx.now()
	if gen <= idx.installedGen {
		// A refresh that started after this one already installed its
		// (fresher) result; this call's data is stale, discard it.
		return nil
	}
	idx.tokens = tokens
	idx.installedGen = gen
	return nil
}
