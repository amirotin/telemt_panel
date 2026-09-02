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
	if response.ConfiguredDriver != "memory" || response.ActiveDriver != "memory" || response.StoreError != "" {
		t.Fatalf("runtime = configured %q active %q error %q", response.ConfiguredDriver, response.ActiveDriver, response.StoreError)
	}
	if len(response.Policies) != len(store.DefaultStoragePolicies()) {
		t.Fatalf("policies = %d", len(response.Policies))
	}
}

func TestHandleGetStorageSettingsReportsTemporaryFallback(t *testing.T) {
	srv, st := newStorageTestServer(t)
	srv.cfg.Store.Driver = "postgres"
	srv.st = store.WithFallback(st, "postgres", "postgres database is unavailable")
	recorder := httptest.NewRecorder()
	srv.handleGetStorageSettings(recorder, httptest.NewRequest(http.MethodGet, "/api/settings/storage", nil))
	var response storageSettingsView
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.ConfiguredDriver != "postgres" || response.ActiveDriver != "memory" || response.StoreError == "" {
		t.Fatalf("fallback runtime = %+v", response)
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
	if got := st.MetricRetention("traffic"); got != 0 {
		t.Fatalf("traffic retention = %v", got)
	}

	policies[0].Enabled = false
	body, _ = json.Marshal(map[string]any{"policies": policies})
	recorder = httptest.NewRecorder()
	srv.handlePutStorageSettings(recorder, httptest.NewRequest(http.MethodPut, "/api/settings/storage", bytes.NewReader(body)))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("disabled technical status = %d", recorder.Code)
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
