package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

func TestSubpageListenerAvailabilityPreservesTokenAndWebLinks(t *testing.T) {
	for _, tc := range []struct {
		name, server string
		showMTProto  bool
	}{
		{"web only", `{"listeners":[{"transport":"web"}]}`, false},
		{"mixed", `{"listeners":[{"transport":"web"},{"transport":"mtproxy"}]}`, true},
		{"default", `{"listeners":[{"port":443}]}`, true},
		{"legacy", `{"port":443}`, true},
		{"unknown", `{}`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			users := fixtureUsers()
			users[0].Links.TLS = []string{"tg://proxy?server=1.2.3.4&port=443&secret=ee" + testUserSecret + "6578616d706c652e6f7267"}
			original, err := json.Marshal(users)
			if err != nil {
				t.Fatal(err)
			}
			fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v1/users":
					fmt.Fprintf(w, `{"ok":true,"data":%s,"revision":"r"}`, original)
				case "/v1/config":
					fmt.Fprintf(w, `{"ok":true,"data":{"server":%s,"web":{"enabled":true,"vhosts":[{"host":"web.example.org","base_path":"relay","profiles":[{"user":"alice","secret_mode":"dd"}]}]}},"revision":"r"}`, tc.server)
				default:
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			t.Cleanup(fake.Close)
			client := telemt.New(fake.URL, "")
			sourceUsers, err := client.Users(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			st, err := store.NewMemory("")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { st.Close() })
			hb := hub.New(hub.Config{}, client, st)
			t.Cleanup(hb.Close)
			srv := New(&config.Config{
				Auth:    config.AuthConfig{Username: "admin", PasswordHash: testPasswordHash},
				Subpage: config.SubpageConfig{Enabled: true, Secret: "panel-secret"},
			}, client, st, hb, "test")
			t.Cleanup(srv.limiter.Stop)
			t.Cleanup(srv.subLimiter.Stop)
			h := subpageTestHandler(srv)
			_, cookie := login(t, h, "admin", testPassword)
			if cookie == nil {
				t.Fatal("login failed")
			}
			before := getSublink(t, h, cookie)
			w := getSubpage(t, h, before.URL)
			if w.Code != http.StatusOK {
				t.Fatalf("subpage: %d %s", w.Code, w.Body)
			}
			body := w.Body.String()
			if strings.Contains(body, "tg://proxy?") != tc.showMTProto {
				t.Fatalf("MTProto visibility = %v, want %v", strings.Contains(body, "tg://proxy?"), tc.showMTProto)
			}
			if !strings.Contains(body, "tg://webproxy?server=web.example.org%2Frelay") || !strings.Contains(body, "data:image/png;base64,") {
				t.Fatal("WEB link with base path and QR must remain available")
			}
			after := getSublink(t, h, cookie)
			if before.URL != after.URL {
				t.Fatalf("token changed: %q -> %q", before.URL, after.URL)
			}
			cached, err := client.Users(context.Background())
			if err != nil || !reflect.DeepEqual(cached, sourceUsers) {
				t.Fatalf("source users changed: %+v, %v", cached, err)
			}
		})
	}
}
