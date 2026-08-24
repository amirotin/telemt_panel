package subpage

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

const testUserSecret = "0123456789abcdef0123456789abcdef"
const rotatedUserSecret = "fedcba9876543210fedcba9876543210"

func classicLink(secret string) []string {
	return []string{"tg://proxy?server=1.2.3.4&port=443&secret=" + secret}
}

// fakeLister is a UsersLister the tests can mutate between calls.
type fakeLister struct {
	users []telemt.UserInfo
	err   error
	calls int
}

func (f *fakeLister) Users(context.Context) ([]telemt.UserInfo, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	return f.users, nil
}

// fakeNonces is a NonceProvider backed by a plain map, for tests that
// don't need the full store.
type fakeNonces struct{ nonces map[string]string }

func newFakeNonces() *fakeNonces { return &fakeNonces{nonces: make(map[string]string)} }

func (f *fakeNonces) GetSubpageNonce(username string) (string, error) {
	return f.nonces[username], nil
}

func (f *fakeNonces) SetSubpageNonce(username, nonce string) error {
	f.nonces[username] = nonce
	return nil
}

func newTestIndex(t *testing.T, lister UsersLister, nonces NonceProvider, now func() time.Time) *Index {
	t.Helper()
	return newIndex([]byte("panel-secret"), lister, nonces, now, 30*time.Second)
}

func TestIndexLookupFindsUserAfterFirstRefresh(t *testing.T) {
	lister := &fakeLister{users: []telemt.UserInfo{
		{Username: "alice", Links: telemt.UserLinks{Classic: classicLink(testUserSecret)}},
	}}
	nonces := newFakeNonces()
	idx := newTestIndex(t, lister, nonces, time.Now)

	token := deriveToken([]byte("panel-secret"), "alice", testUserSecret, "")
	username, ok := idx.Lookup(context.Background(), token)
	if !ok || username != "alice" {
		t.Fatalf("Lookup() = (%q, %v), want (alice, true)", username, ok)
	}
	if lister.calls != 1 {
		t.Fatalf("Users() called %d times, want 1", lister.calls)
	}
}

func TestIndexLookupUnknownTokenReturnsFalse(t *testing.T) {
	lister := &fakeLister{}
	idx := newTestIndex(t, lister, newFakeNonces(), time.Now)

	if _, ok := idx.Lookup(context.Background(), "bogus"); ok {
		t.Fatal("expected an unknown token to miss")
	}
}

func TestIndexMissesAreThrottled(t *testing.T) {
	now := time.Now()
	clock := func() time.Time { return now }
	lister := &fakeLister{}
	idx := newTestIndex(t, lister, newFakeNonces(), clock)

	// First miss triggers a refresh.
	idx.Lookup(context.Background(), "bogus")
	if lister.calls != 1 {
		t.Fatalf("calls after first miss = %d, want 1", lister.calls)
	}

	// A second miss within the interval must not hit Telemt again.
	idx.Lookup(context.Background(), "bogus")
	if lister.calls != 1 {
		t.Fatalf("calls after second miss (same window) = %d, want 1", lister.calls)
	}

	// Advancing past the interval allows one more refresh.
	now = now.Add(31 * time.Second)
	idx.Lookup(context.Background(), "bogus")
	if lister.calls != 2 {
		t.Fatalf("calls after interval elapsed = %d, want 2", lister.calls)
	}
}

func TestIndexSecretRotationInvalidatesOldToken(t *testing.T) {
	lister := &fakeLister{users: []telemt.UserInfo{
		{Username: "alice", Links: telemt.UserLinks{Classic: classicLink(testUserSecret)}},
	}}
	nonces := newFakeNonces()
	idx := newTestIndex(t, lister, nonces, time.Now)

	oldToken := deriveToken([]byte("panel-secret"), "alice", testUserSecret, "")
	if _, ok := idx.Lookup(context.Background(), oldToken); !ok {
		t.Fatal("old token should resolve before rotation")
	}

	// Simulate Telemt rotating the user's secret.
	lister.users[0].Links = telemt.UserLinks{Classic: classicLink(rotatedUserSecret)}
	if err := idx.Refresh(context.Background()); err != nil {
		t.Fatalf("Refresh: %v", err)
	}

	if _, ok := idx.Lookup(context.Background(), oldToken); ok {
		t.Fatal("old token still resolves after secret rotation")
	}
	newToken := deriveToken([]byte("panel-secret"), "alice", rotatedUserSecret, "")
	if username, ok := idx.Lookup(context.Background(), newToken); !ok || username != "alice" {
		t.Fatalf("new token Lookup() = (%q, %v), want (alice, true)", username, ok)
	}
}

func TestIndexNonceRotationInvalidatesOldToken(t *testing.T) {
	lister := &fakeLister{users: []telemt.UserInfo{
		{Username: "alice", Links: telemt.UserLinks{Classic: classicLink(testUserSecret)}},
	}}
	nonces := newFakeNonces()
	idx := newTestIndex(t, lister, nonces, time.Now)

	oldToken := deriveToken([]byte("panel-secret"), "alice", testUserSecret, "")
	if _, ok := idx.Lookup(context.Background(), oldToken); !ok {
		t.Fatal("old token should resolve before rotation")
	}

	if err := nonces.SetSubpageNonce("alice", "new-nonce"); err != nil {
		t.Fatalf("SetSubpageNonce: %v", err)
	}
	if err := idx.Refresh(context.Background()); err != nil {
		t.Fatalf("Refresh: %v", err)
	}

	if _, ok := idx.Lookup(context.Background(), oldToken); ok {
		t.Fatal("old token still resolves after nonce rotation")
	}
	newToken := deriveToken([]byte("panel-secret"), "alice", testUserSecret, "new-nonce")
	if username, ok := idx.Lookup(context.Background(), newToken); !ok || username != "alice" {
		t.Fatalf("new token Lookup() = (%q, %v), want (alice, true)", username, ok)
	}
}

func TestIndexRefreshErrorLeavesExistingTokensUsable(t *testing.T) {
	lister := &fakeLister{users: []telemt.UserInfo{
		{Username: "alice", Links: telemt.UserLinks{Classic: classicLink(testUserSecret)}},
	}}
	idx := newTestIndex(t, lister, newFakeNonces(), time.Now)

	token := deriveToken([]byte("panel-secret"), "alice", testUserSecret, "")
	if _, ok := idx.Lookup(context.Background(), token); !ok {
		t.Fatal("expected the token to resolve on the first, successful refresh")
	}

	lister.err = errors.New("telemt unreachable")
	if _, ok := idx.Lookup(context.Background(), token); !ok {
		t.Fatal("a later failed refresh must not evict already-known tokens")
	}
}

// blockingLister is a UsersLister whose Users call signals entered (once,
// non-blocking) and then blocks until release is closed — used to hold a
// refresh "in flight" while concurrent Lookup calls race against it, the
// way the public /sub/* handler's concurrent misses would against a real,
// slow Telemt round trip.
type blockingLister struct {
	mu      sync.Mutex
	calls   int
	entered chan struct{}
	release chan struct{}
}

func newBlockingLister() *blockingLister {
	return &blockingLister{
		entered: make(chan struct{}, 1),
		release: make(chan struct{}),
	}
}

func (b *blockingLister) Users(context.Context) ([]telemt.UserInfo, error) {
	b.mu.Lock()
	b.calls++
	b.mu.Unlock()

	select {
	case b.entered <- struct{}{}:
	default:
	}
	<-b.release
	return nil, nil
}

func (b *blockingLister) callCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.calls
}

// TestIndexConcurrentMissesRefreshExactlyOnce guards against the
// check-then-act race in the refresh throttle: many goroutines missing
// concurrently while the index is due for a refresh must trigger exactly
// one Users() call, not one per goroutine that observed "due" before the
// winner finished. blockingLister holds the winner's fetch open so any
// racing goroutine that would have wrongly claimed the window (under the
// old separate check-then-write logic) gets the chance to do so before
// the winner completes.
func TestIndexConcurrentMissesRefreshExactlyOnce(t *testing.T) {
	now := time.Now()
	clock := func() time.Time { return now } // frozen: only the true winner can ever see "due"

	lister := newBlockingLister()
	idx := newTestIndex(t, lister, newFakeNonces(), clock)

	const n = 50
	ready := make(chan struct{}, n)
	proceed := make(chan struct{})

	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			ready <- struct{}{}
			<-proceed
			idx.Lookup(context.Background(), "bogus-token")
		}()
	}

	// Wait for every goroutine to be parked at the gate, then release them
	// all at once to maximize concurrent contention on the claim.
	for i := 0; i < n; i++ {
		<-ready
	}
	close(proceed)

	select {
	case <-lister.entered:
		// The winner is now blocked inside Users(); every other goroutine
		// has either already lost the claim or will lose it (the frozen
		// clock makes a second claim impossible regardless of timing).
	case <-time.After(5 * time.Second):
		t.Fatal("no goroutine entered Users() within the deadline")
	}
	close(lister.release)

	wg.Wait()

	if got := lister.callCount(); got != 1 {
		t.Fatalf("Users() called %d times concurrently, want exactly 1", got)
	}
}

// callGate drives one call to a sequencedLister: entered is closed as soon
// as the call is received (which, for a call made from inside Refresh,
// is always after Refresh has already claimed its generation number —
// the claim happens before the Users() call), so a test can wait on it to
// know the claim has happened without polling or sleeping; the call then
// blocks until release is closed, returning users.
type callGate struct {
	entered chan struct{}
	release chan struct{}
	users   []telemt.UserInfo
}

func newCallGate(users []telemt.UserInfo) *callGate {
	return &callGate{entered: make(chan struct{}), release: make(chan struct{}), users: users}
}

// sequencedLister is a UsersLister whose successive Users() calls are each
// driven by their own callGate, in call order.
type sequencedLister struct {
	mu    sync.Mutex
	calls int
	gates []*callGate
}

func (s *sequencedLister) Users(context.Context) ([]telemt.UserInfo, error) {
	s.mu.Lock()
	g := s.gates[s.calls]
	s.calls++
	s.mu.Unlock()

	close(g.entered)
	<-g.release
	return g.users, nil
}

// TestIndexRefreshDiscardsStaleOutOfOrderResult guards the generation
// guard: two Refresh calls started in order (A then B) but finished out of
// order (B, the call that started later, completes and installs first)
// must leave B's map installed — A's later completion must not clobber it
// with older data.
func TestIndexRefreshDiscardsStaleOutOfOrderResult(t *testing.T) {
	oldUser := telemt.UserInfo{Username: "alice", Links: telemt.UserLinks{Classic: classicLink(testUserSecret)}}
	newUser := telemt.UserInfo{Username: "alice", Links: telemt.UserLinks{Classic: classicLink(rotatedUserSecret)}}

	gateA := newCallGate([]telemt.UserInfo{oldUser})
	gateB := newCallGate([]telemt.UserInfo{newUser})
	lister := &sequencedLister{gates: []*callGate{gateA, gateB}}
	idx := newTestIndex(t, lister, newFakeNonces(), time.Now)

	resultA := make(chan error, 1)
	resultB := make(chan error, 1)

	// Start A first so it claims the lower generation number, then wait
	// for confirmation (gateA.entered) that the claim has happened before
	// starting B — deterministic ordering with no sleep or polling.
	go func() { resultA <- idx.Refresh(context.Background()) }()
	<-gateA.entered

	go func() { resultB <- idx.Refresh(context.Background()) }()
	<-gateB.entered

	// Let B — the call that started second — finish and install first.
	close(gateB.release)
	if err := <-resultB; err != nil {
		t.Fatalf("Refresh (B): %v", err)
	}

	// Now let A — the call that started first — finish last. Its result
	// must be discarded rather than overwriting B's.
	close(gateA.release)
	if err := <-resultA; err != nil {
		t.Fatalf("Refresh (A): %v", err)
	}

	newToken := deriveToken([]byte("panel-secret"), "alice", rotatedUserSecret, "")
	if username, ok := idx.Lookup(context.Background(), newToken); !ok || username != "alice" {
		t.Fatalf("Lookup(newToken) = (%q, %v), want (alice, true) — the newer refresh's result must win", username, ok)
	}
	oldToken := deriveToken([]byte("panel-secret"), "alice", testUserSecret, "")
	if _, ok := idx.Lookup(context.Background(), oldToken); ok {
		t.Fatal("Lookup(oldToken) hit — the older, stale refresh clobbered the newer one's result")
	}
}

func TestIndexSkipsUsersWithoutAnExtractableSecret(t *testing.T) {
	lister := &fakeLister{users: []telemt.UserInfo{
		{Username: "no-links"},
	}}
	idx := newTestIndex(t, lister, newFakeNonces(), time.Now)

	if err := idx.Refresh(context.Background()); err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if _, ok := idx.Lookup(context.Background(), "anything"); ok {
		t.Fatal("expected no token for a user with no extractable secret")
	}
}
