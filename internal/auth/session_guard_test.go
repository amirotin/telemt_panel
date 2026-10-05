package auth

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
)

type revokeFailureStore struct {
	store.StateStore
	err error
}

func (s revokeFailureStore) DeleteSession(string) error       { return s.err }
func (s revokeFailureStore) DeleteOtherSessions(string) error { return s.err }

func putGuardSession(t *testing.T, st store.StateStore, hash string, now time.Time) {
	t.Helper()
	if err := st.PutSession(store.Session{IDHash: hash, Created: now, LastSeen: now}); err != nil {
		t.Fatal(err)
	}
}

func TestSessionGuardRegistrationRevokeRace(t *testing.T) {
	st := newMemoryStore(t)
	t.Cleanup(func() { _ = st.Close() })
	g := NewSessionGuard(st, func() time.Duration { return time.Hour }, time.Now)
	t.Cleanup(g.Close)
	for i := 0; i < 100; i++ {
		hash := HashToken(time.Now().String())
		putGuardSession(t, st, hash, time.Now())
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		var ctx context.Context
		var release func()
		var trackErr, revokeErr error
		go func() { defer wg.Done(); <-start; ctx, release, trackErr = g.Track(context.Background(), hash) }()
		go func() { defer wg.Done(); <-start; revokeErr = g.Revoke(hash) }()
		close(start)
		wg.Wait()
		if revokeErr != nil {
			t.Fatal(revokeErr)
		}
		if trackErr == nil {
			if ctx.Err() == nil {
				t.Fatal("registration remained active after revoke")
			}
			release()
			release()
		}
		if _, _, err := g.Track(context.Background(), hash); err == nil {
			t.Fatal("revoked session registered")
		}
	}
}

func TestSessionGuardRevokeOthersAndClose(t *testing.T) {
	st := newMemoryStore(t)
	t.Cleanup(func() { _ = st.Close() })
	now := time.Now()
	g := NewSessionGuard(st, func() time.Duration { return time.Hour }, func() time.Time { return now })
	putGuardSession(t, st, "keep", now)
	putGuardSession(t, st, "other", now)
	keep, releaseKeep, err := g.Track(context.Background(), "keep")
	if err != nil {
		t.Fatal(err)
	}
	other, releaseOther, err := g.Track(context.Background(), "other")
	if err != nil {
		t.Fatal(err)
	}
	defer releaseKeep()
	defer releaseOther()
	if err := g.RevokeOthers("keep"); err != nil {
		t.Fatal(err)
	}
	if keep.Err() != nil || other.Err() == nil {
		t.Fatal("revoke others canceled the wrong streams")
	}
	putGuardSession(t, st, "new", now)
	fresh, releaseFresh, err := g.Track(context.Background(), "new")
	if err != nil {
		t.Fatal(err)
	}
	defer releaseFresh()
	if fresh.Err() != nil {
		t.Fatal("new session revoked by earlier operation")
	}
	now = now.Add(2 * time.Hour)
	if g.Check("keep") == nil {
		t.Fatal("quiet session did not expire")
	}
	if keep.Err() == nil {
		t.Fatal("expired stream not canceled")
	}
	g.Close()
	g.Close()
	if fresh.Err() == nil {
		t.Fatal("Close left a stream active")
	}
	if _, _, err := g.Track(context.Background(), "new"); err == nil {
		t.Fatal("closed guard admits streams")
	}
}

func TestSessionGuardDurableRevokeFailurePreservesStreams(t *testing.T) {
	st := newMemoryStore(t)
	t.Cleanup(func() { _ = st.Close() })
	putGuardSession(t, st, "hash", time.Now())
	want := errors.New("durability unavailable")
	g := NewSessionGuard(revokeFailureStore{st, want}, func() time.Duration { return time.Hour }, time.Now)
	defer g.Close()
	ctx, release, err := g.Track(context.Background(), "hash")
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if !errors.Is(g.Revoke("hash"), want) || ctx.Err() != nil {
		t.Fatal("failed revoke reported success or canceled a valid session")
	}
	if !errors.Is(g.RevokeOthers("keep"), want) || ctx.Err() != nil {
		t.Fatal("failed revoke-others canceled a valid session")
	}
}
