package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/store"
)

func newStorageTestServer(t *testing.T) (*Server, *store.Memory) {
	t.Helper()
	st, err := store.NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return &Server{st: st, cfg: &config.Config{}}, st
}

func TestHandleGetStorageSettings(t *testing.T) {
	srv, _ := newStorageTestServer(t)
	recorder := httptest.NewRecorder()
	srv.handleGetStorageSettings(recorder, httptest.NewRequest(http.MethodGet, "/api/settings/storage", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var response storageSettingsView
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Stats.Driver != "memory" || response.Stats.Durable {
		t.Fatalf("stats = %+v", response.Stats)
	}
	if response.StateDurable {
		t.Fatal("RAM-only test state was reported as durable")
	}
	if len(response.Policies) != len(store.DefaultStoragePolicies()) {
		t.Fatalf("policies = %d", len(response.Policies))
	}
}

func TestHandlePutStorageSettings(t *testing.T) {
	srv, st := newStorageTestServer(t)
	policies := store.DefaultStoragePolicies()
	for i := range policies {
		if policies[i].Category == store.StorageTraffic {
			policies[i].Enabled = false
		}
	}
	body, _ := json.Marshal(map[string]any{"policies": policies})
	recorder := httptest.NewRecorder()
	srv.handlePutStorageSettings(recorder, httptest.NewRequest(http.MethodPut, "/api/settings/storage", bytes.NewReader(body)))
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if got := st.MetricRetention("traffic"); got != store.LiveMetricRetention {
		t.Fatalf("traffic retention = %v", got)
	}

	policies[0].Enabled = false
	body, _ = json.Marshal(map[string]any{"policies": policies})
	recorder = httptest.NewRecorder()
	srv.handlePutStorageSettings(recorder, httptest.NewRequest(http.MethodPut, "/api/settings/storage", bytes.NewReader(body)))
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("disabled technical status = %d", recorder.Code)
	}
}

func TestStorageRetentionReductionRequiresConfirmation(t *testing.T) {
	srv, st := newStorageTestServer(t)
	policies := store.DefaultStoragePolicies()
	policies[0].RetentionDays = 7
	for _, confirm := range []bool{false, true} {
		body, _ := json.Marshal(map[string]any{"policies": policies, "confirm_retention_reduction": confirm})
		w := httptest.NewRecorder()
		srv.handlePutStorageSettings(w, httptest.NewRequest(http.MethodPut, "/api/settings/storage", bytes.NewReader(body)))
		stored, _ := st.ListStoragePolicies()
		if !confirm && (w.Code != http.StatusBadRequest || stored[0].RetentionDays != 30) {
			t.Fatalf("unconfirmed reduction changed state: %d %+v", w.Code, stored[0])
		}
		if confirm && (w.Code != http.StatusNoContent || stored[0].RetentionDays != 7) {
			t.Fatalf("confirmed reduction failed: %d %+v", w.Code, stored[0])
		}
	}
}

func TestHandlePurgeStorageHistoryRequiresConfirmation(t *testing.T) {
	srv, st := newStorageTestServer(t)
	if err := st.RecordMetric("traffic", store.MetricPoint{TS: time.Now().Unix(), Value: 1}); err != nil {
		t.Fatal(err)
	}

	recorder := httptest.NewRecorder()
	srv.handlePurgeStorageHistory(recorder, httptest.NewRequest(http.MethodPost, "/api/settings/storage/purge", bytes.NewBufferString(`{"category":"traffic","confirm":false}`)))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("unconfirmed status = %d", recorder.Code)
	}
	if got, _ := st.MetricRange("traffic", 0); len(got) != 1 {
		t.Fatalf("unconfirmed purge removed data: %+v", got)
	}

	recorder = httptest.NewRecorder()
	srv.handlePurgeStorageHistory(recorder, httptest.NewRequest(http.MethodPost, "/api/settings/storage/purge", bytes.NewBufferString(`{"category":"traffic","confirm":true}`)))
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("confirmed status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if got, _ := st.MetricRange("traffic", 0); len(got) != 0 {
		t.Fatalf("confirmed purge kept data: %+v", got)
	}
}

func TestHandleResetUserTrafficRequiresConfirmation(t *testing.T) {
	srv, st := newStorageTestServer(t)
	seedUserTraffic(t, st, "alice")

	req := httptest.NewRequest(http.MethodPost, "/api/users/alice/traffic/reset", bytes.NewBufferString(`{"confirm":false}`))
	req.SetPathValue("username", "alice")
	recorder := httptest.NewRecorder()
	srv.handleResetUserTraffic(recorder, req)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("unconfirmed status = %d", recorder.Code)
	}
	if summaries, _ := st.UserTrafficSummaries(); summaries["alice"].ObservedTotalBytes != 100 {
		t.Fatalf("unconfirmed reset changed traffic: %+v", summaries)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/users/alice/traffic/reset", bytes.NewBufferString(`{"confirm":true}`))
	req.SetPathValue("username", "alice")
	recorder = httptest.NewRecorder()
	srv.handleResetUserTraffic(recorder, req)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("confirmed status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if summaries, _ := st.UserTrafficSummaries(); len(summaries) != 0 {
		t.Fatalf("confirmed reset kept traffic: %+v", summaries)
	}
}

func TestHandleResetAllUserTraffic(t *testing.T) {
	srv, st := newStorageTestServer(t)
	seedUserTraffic(t, st, "alice")
	seedUserTraffic(t, st, "bob")

	recorder := httptest.NewRecorder()
	srv.handleResetAllUserTraffic(recorder, httptest.NewRequest(http.MethodPost, "/api/traffic/reset", bytes.NewBufferString(`{"confirm":true}`)))
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if summaries, _ := st.UserTrafficSummaries(); len(summaries) != 0 {
		t.Fatalf("reset kept summaries: %+v", summaries)
	}
	if state, _ := st.UserTrafficCollectorState(); state.LastSuccessTS != 0 {
		t.Fatalf("reset kept collector: %+v", state)
	}
}

func seedUserTraffic(t *testing.T, st store.Store, username string) {
	t.Helper()
	now := time.Now().Unix()
	state, err := st.UserTrafficCollectorState()
	if err != nil {
		t.Fatal(err)
	}
	if now <= state.LastSuccessTS+1 {
		now = state.LastSuccessTS + 2
	}
	sourceStartedAt := state.SourceStartedAt
	if sourceStartedAt == 0 {
		sourceStartedAt = now - 3600
	}
	for _, observation := range []struct {
		at  int64
		raw uint64
	}{{now - 1, 10}, {now, 110}} {
		if _, err := st.ApplyUserTrafficSnapshot(store.UserTrafficSnapshot{
			ObservedAt: observation.at, SourceStartedAt: sourceStartedAt, TelemetryEnabled: true,
			Users: []store.UserTrafficObservation{{Username: username, RawOctets: observation.raw}},
		}); err != nil {
			t.Fatal(err)
		}
	}
}
