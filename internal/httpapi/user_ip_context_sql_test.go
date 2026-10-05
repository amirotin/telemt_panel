//go:build !lite

package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
)

func TestUserIPHistoryDeadlineInterruptsBusyStore(t *testing.T) {
	state, err := store.NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	history, err := store.NewSQLite(filepath.Join(t.TempDir(), "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.NewComposite(state, history)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	held, err := history.BeginTrafficRead(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	r := httptest.NewRequest(http.MethodGet, "/api/users/alice/ip-history", nil).WithContext(ctx)
	r.SetPathValue("username", "alice")
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		(&Server{st: st}).handleGetUserIPHistory(w, r)
	}()
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		held.Close()
		<-done
		t.Fatal("IP history ignored request deadline while the SQLite connection was occupied")
	}
	if w.Code != http.StatusGatewayTimeout || !strings.Contains(w.Body.String(), `"code":"history_timeout"`) {
		t.Fatalf("deadline status=%d body=%s", w.Code, w.Body.String())
	}
}
