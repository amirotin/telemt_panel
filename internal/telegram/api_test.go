package telegram

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/telemt/telemt-panel/internal/config"
	_ "modernc.org/sqlite"
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

func TestAPIRotateUserSecretFallsBackToRecreate(t *testing.T) {
	var patched, deleted, created bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPatch && r.URL.Path == "/v1/users/alice":
			patched = true
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"ok":false}`))
		case r.Method == http.MethodDelete && r.URL.Path == "/v1/users/alice":
			deleted = true
			w.Write([]byte(`{"ok":true}`))
		case r.Method == http.MethodPost && r.URL.Path == "/v1/users":
			created = true
			w.Write([]byte(`{"ok":true}`))
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	secret, err := newTestBot(srv.URL).apiRotateUserSecret("alice", "oldsecret", "0123456789abcdef")
	if err != nil {
		t.Fatalf("rotate failed: %v", err)
	}
	if secret != "0123456789abcdef" {
		t.Fatalf("unexpected secret: %s", secret)
	}
	if !patched || !deleted || !created {
		t.Fatalf("expected patch/delete/create, got patch=%v delete=%v create=%v", patched, deleted, created)
	}
}

func TestReplyMapAndSecretUpdate(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "users.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := initSchema(db); err != nil {
		t.Fatal(err)
	}
	b := &Bot{db: db}

	b.dbAddUser("alice", 123, "oldsecret")
	b.dbUpdateUserSecret("alice", "newsecret")
	uid, secret := b.dbGetUserByName("alice")
	if uid != 123 || secret != "newsecret" {
		t.Fatalf("unexpected user row: uid=%d secret=%s", uid, secret)
	}

	b.dbSaveReplyMap(42, 123)
	if got := b.dbGetReplyTarget(42); got != 123 {
		t.Fatalf("unexpected reply target: %d", got)
	}
}

func TestReplyProxyName(t *testing.T) {
	msg := &tgbotapi.Message{Text: "🏷 Прокси: alice_123\n(Reply на пересланное сообщение для ответа)"}
	if got := replyProxyName(msg); got != "alice_123" {
		t.Fatalf("unexpected proxy name: %q", got)
	}
}
