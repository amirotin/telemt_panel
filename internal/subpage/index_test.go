package subpage

import (
	"context"
	"errors"
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

func newTestIndex(t *testing.T, lister *fakeLister, nonces NonceProvider, now func() time.Time) *Index {
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
