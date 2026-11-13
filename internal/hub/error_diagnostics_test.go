package hub

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

func TestSourceErrorPreservesTelemtFailureKind(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
		code string
	}{
		{"server error", `{"ok":false,"error":{"code":"internal_error","message":"UPSTREAM_SECRET"}}`, "telemt_api_error"},
		{"config permissions", `{"ok":false,"error":{"code":"internal_error","message":"failed to write config: Operation not permitted (os error 1)"}}`, "telemt_config_permission_denied"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusInternalServerError)
				fmt.Fprint(w, tc.body)
			}))
			t.Cleanup(upstream.Close)
			h := New(Config{UsersInterval: time.Hour}, telemt.New(upstream.URL, ""), nil)
			t.Cleanup(h.Close)
			ch, _, cancel, err := h.Subscribe([]string{"users"})
			if err != nil {
				t.Fatal(err)
			}
			defer cancel()
			ev := recvEvent(t, ch, 2*time.Second)
			if ev.Err != tc.code {
				t.Fatalf("source error = %q, want %q", ev.Err, tc.code)
			}
			if len(ev.Data) != 0 {
				t.Fatal("source error included an upstream response payload")
			}
		})
	}
}
