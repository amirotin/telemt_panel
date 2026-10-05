//go:build !lite

package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

// Keep traffic in memory for the IP case, so only the real SQLite IP read
// waits for the held connection. No successful IP/traffic data is fabricated.
type ipOnlyEnrichmentStore struct {
	store.Store
	traffic store.HistoryStore
}

func (s *ipOnlyEnrichmentStore) UserTrafficSummaries() (map[string]store.UserTrafficSummary, error) {
	return s.traffic.UserTrafficSummaries()
}

func (s *ipOnlyEnrichmentStore) BeginTrafficRead(ctx context.Context) (store.TrafficReadSnapshot, error) {
	return s.traffic.BeginTrafficRead(ctx)
}

func TestUserEnrichmentCancellationReleasesHeldConnectionWait(t *testing.T) {
	for _, name := range []string{"traffic list", "traffic single", "IP list"} {
		t.Run(name, func(t *testing.T) {
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
			var application store.Store = st
			if name == "IP list" {
				application = &ipOnlyEnrichmentStore{Store: st, traffic: state}
			}
			fake := newFakeTelemt(telemt.UserInfo{Username: "alice", Enabled: true})
			quotaRequested := make(chan struct{})
			var once sync.Once
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				fake.route(w, r)
				if r.URL.Path == "/v1/stats/users/quota" {
					once.Do(func() { close(quotaRequested) })
				}
			}))
			defer upstream.Close()
			s := &Server{cfg: &config.Config{}, tc: telemt.New(upstream.URL, ""), st: application}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			r := httptest.NewRequest(http.MethodGet, "/api/users", nil).WithContext(ctx)
			r.SetPathValue("username", "alice")
			w := httptest.NewRecorder()
			done := make(chan struct{})
			go func() {
				defer close(done)
				if name == "traffic single" {
					s.handleGetUser(w, r)
				} else {
					s.handleListUsers(w, r)
				}
			}()
			select {
			case <-quotaRequested:
			case <-time.After(2 * time.Second):
				held.Close()
				cancel()
				<-done
				t.Fatal("user fetch did not reach enrichment")
			}
			cancel()
			select {
			case <-done:
			case <-time.After(500 * time.Millisecond):
				// Release the held resource and join the handler before failing.
				held.Close()
				<-done
				t.Fatal("cancelled HTTP enrichment kept waiting for the held SQLite connection")
			}
			if w.Code != http.StatusOK {
				t.Fatalf("degraded status=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
}
