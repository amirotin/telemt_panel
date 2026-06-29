package telegram

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/telemt/telemt-panel/internal/config"
)

func newTestBot(apiURL string) *Bot {
	return &Bot{
		cfg: &config.Config{
			Telemt: config.TelemtConfig{URL: apiURL},
		},
		httpClient: &http.Client{Timeout: time.Second},
	}
}

func TestAPIDoReturnsErrorOnNonSuccessStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"ok":false,"error":{"message":"boom"}}`))
	}))
	defer srv.Close()

	_, err := newTestBot(srv.URL).apiDo(http.MethodDelete, "/users/alice", nil)
	if err == nil {
		t.Fatal("expected error for 500 response")
	}
}

func TestAPIDoKeepsConflictAsResult(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		w.Write([]byte(`{"ok":false}`))
	}))
	defer srv.Close()

	resp, err := newTestBot(srv.URL).apiDo(http.MethodPost, "/users", map[string]string{"username": "alice"})
	if err != nil {
		t.Fatalf("expected conflict result without error, got %v", err)
	}
	if conflict, _ := resp["_conflict"].(bool); !conflict {
		t.Fatalf("expected _conflict marker, got %#v", resp)
	}
}
