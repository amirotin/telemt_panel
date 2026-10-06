package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
)

type timeoutHistoryStore struct {
	store.Store
	ctx context.Context
}

type historyContextTestKey struct{}

func (s *timeoutHistoryStore) MetricRangeContext(ctx context.Context, name string, from int64) ([]store.MetricPoint, error) {
	s.ctx = ctx
	return nil, context.DeadlineExceeded
}
func (s *timeoutHistoryStore) ListHistoryEventsContext(ctx context.Context, filter store.HistoryEventFilter) ([]store.HistoryEvent, error) {
	s.ctx = ctx
	return nil, context.DeadlineExceeded
}
func (s *timeoutHistoryStore) BeginTrafficRead(ctx context.Context) (store.TrafficReadSnapshot, error) {
	s.ctx = ctx
	return nil, context.DeadlineExceeded
}
func (s *timeoutHistoryStore) StorageStatsContext(ctx context.Context) (store.StorageStats, error) {
	s.ctx = ctx
	return store.StorageStats{}, context.DeadlineExceeded
}
func (s *timeoutHistoryStore) PurgeHistoryContext(ctx context.Context, category store.StorageCategory) error {
	s.ctx = ctx
	return context.DeadlineExceeded
}
func (s *timeoutHistoryStore) ReplaceStoragePoliciesContext(ctx context.Context, policies []store.StoragePolicy) error {
	s.ctx = ctx
	return context.DeadlineExceeded
}
func (s *timeoutHistoryStore) DeleteUserHistoryContext(ctx context.Context, username string) error {
	s.ctx = ctx
	return context.DeadlineExceeded
}
func (s *timeoutHistoryStore) ResetUserTrafficContext(ctx context.Context) error {
	s.ctx = ctx
	return context.DeadlineExceeded
}
func (s *timeoutHistoryStore) ResetUserIPHistoryContext(ctx context.Context, username string) error {
	s.ctx = ctx
	return context.DeadlineExceeded
}

func TestHistoryTimeoutHTTPForwardsContextAndNeverWritesSuccess(t *testing.T) {
	policyBody, err := json.Marshal(map[string]any{"policies": store.DefaultStoragePolicies()})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		path, body string
		handler    func(*Server, http.ResponseWriter, *http.Request)
	}{
		{"/api/history?metric=connections&range=24h", "", (*Server).handleGetHistory},
		{"/api/history/events?range=24h", "", (*Server).handleGetHistoryEvents},
		{"/api/users/alice/traffic-history?range=24h", "", (*Server).handleGetUserTrafficHistory},
		{"/api/traffic/summary?range=24h", "", (*Server).handleGetTrafficSummary},
		{"/api/traffic/users?range=24h", "", (*Server).handleGetTrafficUsers},
		{"/api/settings/storage", "", (*Server).handleGetStorageSettings},
		{"/api/settings/storage", string(policyBody), (*Server).handlePutStorageSettings},
		{"/api/settings/storage/purge", `{"category":"technical","confirm":true}`, (*Server).handlePurgeStorageHistory},
		{"/api/settings/storage/purge", `{"category":"user_ip_history","confirm":true}`, (*Server).handlePurgeStorageHistory},
		{"/api/users/alice/traffic/reset", `{"confirm":true}`, (*Server).handleResetUserTraffic},
		{"/api/traffic/reset", `{"confirm":true}`, (*Server).handleResetAllUserTraffic},
		{"/api/users/alice/ip-history/reset", `{"confirm":true}`, (*Server).handleResetUserIPHistory},
	} {
		t.Run(tc.path+tc.body, func(t *testing.T) {
			memory, err := store.NewMemory("")
			if err != nil {
				t.Fatal(err)
			}
			st := &timeoutHistoryStore{Store: memory}
			server := &Server{st: st}
			request := httptest.NewRequest(http.MethodGet, tc.path, bytes.NewBufferString(tc.body))
			request.SetPathValue("username", "alice")
			ctx, cancel := context.WithTimeout(context.WithValue(request.Context(), historyContextTestKey{}, "request"), time.Minute)
			defer cancel()
			request = request.WithContext(ctx)
			response := httptest.NewRecorder()
			tc.handler(server, response, request)
			if response.Code != http.StatusGatewayTimeout {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			var result map[string]any
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result["code"] != "history_timeout" || result["points"] != nil || st.ctx == nil || st.ctx.Value(historyContextTestKey{}) != "request" {
				t.Fatalf("response=%+v context=%v", result, st.ctx)
			}
			// Handlers may shorten the deadline while preserving request context.
			requestDeadline, _ := ctx.Deadline()
			if deadline, ok := st.ctx.Deadline(); !ok || deadline.After(requestDeadline) {
				t.Fatal("history operation lost or extended the request deadline")
			}
			cancel()
			if st.ctx.Err() == nil {
				t.Fatal("history operation lost request cancellation")
			}
		})
	}
}
