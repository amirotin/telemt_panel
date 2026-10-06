package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
)

func ipLimitSettingsRequest(t *testing.T, srv *Server, value any, include, confirm bool) *httptest.ResponseRecorder {
	return ipLimitSettingsRequestContext(t, context.Background(), srv, value, include, confirm)
}

func ipLimitSettingsRequestContext(t *testing.T, ctx context.Context, srv *Server, value any, include, confirm bool) *httptest.ResponseRecorder {
	t.Helper()
	encoded, err := json.Marshal(store.DefaultStoragePolicies())
	if err != nil {
		t.Fatal(err)
	}
	var policies []map[string]any
	if err := json.Unmarshal(encoded, &policies); err != nil {
		t.Fatal(err)
	}
	for _, policy := range policies {
		if policy["category"] == "user_ip_history" {
			delete(policy, "max_ips_per_user")
			if include {
				policy["max_ips_per_user"] = value
			}
		}
	}
	body, err := json.Marshal(map[string]any{"policies": policies, "confirm_retention_reduction": confirm})
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	srv.handlePutStorageSettings(w, httptest.NewRequest(http.MethodPut, "/api/settings/storage", bytes.NewReader(body)).WithContext(ctx))
	return w
}

type blockedIPPolicyStore struct {
	store.Store
	entered chan struct{}
	release chan struct{}
	writes  atomic.Int32
}

func (s *blockedIPPolicyStore) ReplaceStoragePoliciesContext(ctx context.Context, policies []store.StoragePolicy) error {
	if s.writes.Add(1) == 1 {
		close(s.entered)
		select {
		case <-s.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return s.Store.ReplaceStoragePoliciesContext(ctx, policies)
}

func TestIPHistoryLimitConcurrentSettingsWaitsBeforeReadingPolicy(t *testing.T) {
	srv, st := newStorageTestServer(t)
	blocked := &blockedIPPolicyStore{Store: st, entered: make(chan struct{}), release: make(chan struct{})}
	srv.st = blocked
	defer func() {
		select {
		case <-blocked.release:
		default:
			close(blocked.release)
		}
	}()
	firstDone := make(chan *httptest.ResponseRecorder, 1)
	go func() { firstDone <- ipLimitSettingsRequest(t, srv, 512, true, false) }()
	select {
	case <-blocked.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("first settings request did not reach the store")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	second := ipLimitSettingsRequestContext(t, ctx, srv, 0, true, false)
	if second.Code != http.StatusGatewayTimeout {
		t.Errorf("concurrent request bypassed policy serialization: %d %s", second.Code, second.Body)
	}
	if blocked.writes.Load() != 1 || st.UserIPLimit() != 256 {
		t.Errorf("waiting request mutated policy: writes=%d limit=%d", blocked.writes.Load(), st.UserIPLimit())
	}
	close(blocked.release)
	select {
	case first := <-firstDone:
		if first.Code != http.StatusNoContent {
			t.Fatalf("first write: %d %s", first.Code, first.Body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("first settings request did not finish")
	}
	if retry := ipLimitSettingsRequest(t, srv, 0, true, false); retry.Code != http.StatusNoContent || st.UserIPLimit() != 0 {
		t.Fatalf("retry failed: %d %s limit=%d", retry.Code, retry.Body, st.UserIPLimit())
	}
}

func readIPLimitHistory(t *testing.T, srv *Server) map[string]any {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/api/users/alice/ip-history?range=all&limit=200", nil)
	r.SetPathValue("username", "alice")
	w := httptest.NewRecorder()
	srv.handleGetUserIPHistory(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("IP history status=%d body=%s", w.Code, w.Body)
	}
	var data map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	return data
}

func TestIPHistoryLimitSettingsAndConfirmation(t *testing.T) {
	srv, st := newStorageTestServer(t)
	if data := readIPLimitHistory(t, srv); data["max_ips_per_user"] != float64(256) {
		t.Fatalf("default effective limit = %v", data["max_ips_per_user"])
	}
	if w := ipLimitSettingsRequest(t, srv, 0, true, false); w.Code != http.StatusNoContent {
		t.Fatalf("unlimited status=%d body=%s", w.Code, w.Body)
	}
	now := time.Now().Unix()
	batch := store.UserIPBatch{ID: "unlimited-api", Through: now}
	for i := 0; i < 300; i++ {
		at := now - int64(300-i)
		batch.Records = append(batch.Records, store.UserIPRecord{Username: "alice", IP: fmt.Sprintf("198.18.%d.%d", i/256, i%256), Family: 4, First: at, Last: at, Observations: 1, Source: 2})
	}
	if err := st.ApplyUserIPBatch(batch); err != nil {
		t.Fatal(err)
	}
	if data := readIPLimitHistory(t, srv); data["max_ips_per_user"] != float64(0) || data["total"] != float64(300) || data["next_cursor"] == "" {
		t.Fatalf("unlimited/pagination lost history: max=%v total=%v cursor=%v", data["max_ips_per_user"], data["total"], data["next_cursor"])
	}
	for _, include := range []bool{false, true} {
		if w := ipLimitSettingsRequest(t, srv, nil, include, false); w.Code != http.StatusNoContent {
			t.Fatalf("legacy omitted/null update status=%d body=%s", w.Code, w.Body)
		}
		if data := readIPLimitHistory(t, srv); data["max_ips_per_user"] != float64(0) || data["total"] != float64(300) {
			t.Fatalf("omitted/null reset explicit unlimited: max=%v total=%v", data["max_ips_per_user"], data["total"])
		}
	}
	if w := ipLimitSettingsRequest(t, srv, 128, true, false); w.Code != http.StatusBadRequest || !bytes.Contains(w.Body.Bytes(), []byte("confirmation_required")) {
		t.Fatalf("unconfirmed reduction status=%d body=%s", w.Code, w.Body)
	}
	if data := readIPLimitHistory(t, srv); data["total"] != float64(300) || data["max_ips_per_user"] != float64(0) {
		t.Fatal("unconfirmed reduction changed history or policy")
	}
	if w := ipLimitSettingsRequest(t, srv, 128, true, true); w.Code != http.StatusNoContent {
		t.Fatalf("confirmed reduction status=%d body=%s", w.Code, w.Body)
	}
	if data := readIPLimitHistory(t, srv); data["total"] != float64(128) || data["max_ips_per_user"] != float64(128) {
		t.Fatalf("confirmed cap was not applied: max=%v total=%v", data["max_ips_per_user"], data["total"])
	}
}

func TestIPHistoryLimitSettingsRejectInvalidNumbers(t *testing.T) {
	for _, value := range []any{-1, 100001, 1.5, "512"} {
		t.Run(fmt.Sprint(value), func(t *testing.T) {
			srv, _ := newStorageTestServer(t)
			w := ipLimitSettingsRequest(t, srv, value, true, true)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("invalid cap status=%d body=%s", w.Code, w.Body)
			}
			if data := readIPLimitHistory(t, srv); data["max_ips_per_user"] != float64(256) {
				t.Fatal("rejected cap changed existing policy")
			}
		})
	}
}
