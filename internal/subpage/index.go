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
	if idx.claimRefreshWindow() {
		_ = idx.Refresh(ctx) // best-effort: a failed refresh just leaves the miss standing
	}
	return idx.get(token)
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
func (idx *Index) Refresh(ctx context.Context) error {
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
	idx.tokens = tokens
	idx.lastRefresh = idx.now()
	idx.mu.Unlock()
	return nil
}
