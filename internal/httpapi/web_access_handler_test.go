package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/amirotin/telemt_panel/internal/telemt"
	"github.com/amirotin/telemt_panel/internal/telemt/telemttest"
)

const webAccessFixture = `{
  "enabled": true,
  "carrier": "https",
  "future_root": 9007199254740993,
  "vhosts": [
    {
      "host": "one.example.com",
      "public_addr": "203.0.113.1:443",
      "decoy": {"mode":"http_upstream","upstream":"http://127.0.0.1:8080"},
      "future_vhost": {"exact":9007199254740993},
      "profiles": [
        {"user":"alice","secret_mode":"plain","max_sessions":10,"future_profile":"kept"},
        {"user":"bob","secret_mode":"dd","max_streams":20}
      ]
    },
    {
      "host": "two.example.com",
      "public_addr": "203.0.113.2:443",
      "decoy": {"mode":"static_directory","directory":"/var/www/html"},
      "profiles": [{"user":"carol","secret_mode":"plain"}]
    }
  ]
}`

func TestProjectWebAccess(t *testing.T) {
	view, err := projectWebAccess(json.RawMessage(webAccessFixture), "rev-1")
	if err != nil {
		t.Fatal(err)
	}
	if view.Revision != "rev-1" || !view.Enabled || len(view.Vhosts) != 2 {
		t.Fatalf("view = %+v", view)
	}
	if got := view.Vhosts[0].Profiles[0]; got.User != "alice" || got.SecretMode != "plain" || got.MaxSessions == nil || *got.MaxSessions != 10 {
		t.Fatalf("profile = %+v", got)
	}
}

func TestProjectWebAccessPreservesBasePath(t *testing.T) {
	raw := json.RawMessage(`{"enabled":true,"vhosts":[{"host":"web.example.org","base_path":"MixedCase/relay","public_addr":"203.0.113.1:443","profiles":[{"user":"alice","secret_mode":"plain"}]}]}`)
	view, err := projectWebAccess(raw, "rev")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(view)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Vhosts []struct {
			BasePath string `json:"base_path"`
		} `json:"vhosts"`
	}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded.Vhosts) != 1 || decoded.Vhosts[0].BasePath != "MixedCase/relay" {
		t.Fatalf("WEB base path lost: %s", encoded)
	}
}

func TestReplaceWebUserProfilesPreservesUnrelatedAndUnknownFields(t *testing.T) {
	maxStreams := uint64(64)
	patch, err := replaceWebUserProfiles(json.RawMessage(webAccessFixture), "alice", []webUserAccessProfile{
		{Vhost: "one.example.com", SecretMode: "plain", MaxStreams: &maxStreams},
		{Vhost: "two.example.com", SecretMode: "dd"},
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(patch)
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Vhosts []struct {
			Host        string `json:"host"`
			FutureVhost struct {
				Exact json.Number `json:"exact"`
			} `json:"future_vhost"`
			Profiles []map[string]json.RawMessage `json:"profiles"`
		} `json:"vhosts"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got.Vhosts) != 2 || got.Vhosts[0].FutureVhost.Exact.String() != "9007199254740993" {
		t.Fatalf("unknown vhost field lost: %s", raw)
	}
	oneAlice := profileForTest(got.Vhosts[0].Profiles, "alice", "plain")
	if oneAlice == nil || string(oneAlice["future_profile"]) != `"kept"` || string(oneAlice["max_streams"]) != "64" {
		t.Fatalf("updated profile did not preserve unknown fields: %s", raw)
	}
	if _, exists := oneAlice["max_sessions"]; exists {
		t.Fatalf("unset inherited limit was retained: %s", raw)
	}
	if profileForTest(got.Vhosts[0].Profiles, "bob", "dd") == nil || profileForTest(got.Vhosts[1].Profiles, "carol", "plain") == nil {
		t.Fatalf("unrelated profiles were lost: %s", raw)
	}
	if profileForTest(got.Vhosts[1].Profiles, "alice", "dd") == nil {
		t.Fatalf("new relationship missing: %s", raw)
	}
}

func TestReplaceWebUserProfilesProtectsEnabledVhost(t *testing.T) {
	raw := json.RawMessage(`{"enabled":true,"vhosts":[{"host":"one.example.com","profiles":[{"user":"alice","secret_mode":"plain"}]}]}`)
	_, err := replaceWebUserProfiles(raw, "alice", nil)
	constraint, ok := err.(*webProfileConstraintError)
	if !ok || constraint.code != "web_profile_required" || constraint.status != http.StatusConflict {
		t.Fatalf("error = %#v", err)
	}
}

func TestValidateWebUserProfiles(t *testing.T) {
	if err := validateWebUserProfiles([]webUserAccessProfile{{Vhost: "one.example.com", SecretMode: "plain"}, {Vhost: "one.example.com", SecretMode: "plain"}}); err == nil {
		t.Fatal("duplicate profile accepted")
	}
	zero := uint64(0)
	if err := validateWebUserProfiles([]webUserAccessProfile{{Vhost: "one.example.com", SecretMode: "dd", MaxSessions: &zero}}); err == nil {
		t.Fatal("zero limit accepted")
	}
}

func TestRawWebHasUser(t *testing.T) {
	raw := json.RawMessage(`{"enabled":true,"vhosts":[{"host":"one.example","profiles":[{"user":"alice","secret_mode":"plain"}]}]}`)
	if !rawWebHasUser(raw, "alice") {
		t.Fatal("alice profile was not found")
	}
	if rawWebHasUser(raw, "bob") {
		t.Fatal("bob must not be reported as a WEB profile owner")
	}
	if rawWebHasUser(json.RawMessage(`not-json`), "alice") {
		t.Fatal("malformed config must not report a relationship")
	}
}

func TestHandleGetTelemtWebAccess(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})
	w := doRequest(t, srv, cookie, http.MethodGet, "/api/telemt/web-access", nil, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", w.Code, w.Body)
	}
	var view webAccessView
	if err := json.Unmarshal(w.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	if view.Revision == "" || !view.Enabled || view.Vhosts == nil {
		t.Fatalf("view = %+v", view)
	}
}

func TestWebAccessReportsAbsentMTProtoListener(t *testing.T) {
	fake := telemttest.New(telemttest.Scenario{})
	t.Cleanup(fake.Close)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" && r.URL.Path == "/v1/config" {
			writeJSON(w, 200, map[string]any{"ok": true, "revision": "rev-0", "data": map[string]json.RawMessage{"web": json.RawMessage(webAccessFixture), "server": json.RawMessage(`{"listeners":[{"transport":"web","port":18080}]}`)}})
			return
		}
		fake.Handler().ServeHTTP(w, r)
	}))
	t.Cleanup(upstream.Close)
	srv, cookie := newTelemtInfoTestServer(t, telemt.New(upstream.URL, ""))
	w := doRequest(t, srv, cookie, "GET", "/api/telemt/web-access", nil, nil)
	var view struct {
		MTProtoListener string `json:"mtproto_listener"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || view.MTProtoListener != "absent" {
		t.Fatalf("HTTP %d: %s", w.Code, w.Body)
	}
}

func TestHandlePutTelemtUserWebAccessRequiresIfMatch(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})
	w := doRequest(t, srv, cookie, http.MethodPut, "/api/telemt/web-access/users/alice", nil, []byte(`{"profiles":[]}`))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", w.Code, w.Body)
	}
}

func TestWebAccessReloadPolicy(t *testing.T) {
	for _, tt := range []struct {
		query  string
		mode   string
		status int
		stale  bool
	}{
		{"", "instant", 202, false},
		{"?reload=drain&timeout_secs=30", "drain", 202, false},
		{"?reload=instant", "instant", 202, false},
		{"?reload=instant", "instant", 504, false},
		{"?reload=drain", "", 400, false},
		{"?reload=drain&timeout_secs=3601", "", 400, false},
		{"?reload=instant&timeout_secs=30", "", 400, false},
		{"?reload=instant&reload=drain", "", 400, false},
		{"?reload=none", "", 400, false},
		{"?unknown=1", "", 400, false},
		{"?reload=drain&timeout_secs=30", "", 409, true},
	} {
		t.Run(tt.query+tt.mode, func(t *testing.T) {
			fake := telemttest.New(telemttest.Scenario{})
			t.Cleanup(fake.Close)
			patches := make(chan url.Values, 1)
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodGet && r.URL.Path == "/v1/config" {
					writeJSON(w, 200, map[string]any{"ok": true, "revision": "rev-0", "data": map[string]json.RawMessage{"web": json.RawMessage(webAccessFixture)}})
					return
				}
				if r.Method == http.MethodPatch && r.URL.Path == "/v1/config" {
					patches <- r.URL.Query()
					if tt.status == 504 {
						http.Error(w, "upstream timeout", http.StatusGatewayTimeout)
						return
					}
				}
				fake.Handler().ServeHTTP(w, r)
			}))
			t.Cleanup(upstream.Close)
			srv, cookie := newTelemtInfoTestServer(t, telemt.New(upstream.URL, ""))
			get := doRequest(t, srv, cookie, "GET", "/api/telemt/web-access", nil, nil)
			var view webAccessView
			if err := json.Unmarshal(get.Body.Bytes(), &view); err != nil || len(view.Vhosts) == 0 {
				t.Fatalf("fixture: %s %v", get.Body, err)
			}
			body, _ := json.Marshal(webUserAccessUpdate{Profiles: []webUserAccessProfile{{Vhost: view.Vhosts[0].Host, SecretMode: "dd"}}})
			revision := view.Revision
			if tt.stale {
				revision = "stale"
			}
			w := doRequest(t, srv, cookie, "PUT", "/api/telemt/web-access/users/alice"+tt.query, map[string]string{"If-Match": revision}, body)
			if w.Code != tt.status {
				t.Fatalf("HTTP %d want %d: %s", w.Code, tt.status, w.Body)
			}
			if tt.status == 504 {
				var failure struct {
					Code string `json:"code"`
				}
				if json.Unmarshal(w.Body.Bytes(), &failure) != nil || failure.Code != "telemt_config_outcome_unknown" {
					t.Fatalf("unconfirmed write: %s", w.Body)
				}
			}
			select {
			case query := <-patches:
				if tt.mode == "" {
					t.Fatal("invalid or stale request patched upstream")
				}
				if query.Get("reload") != tt.mode {
					t.Fatalf("reload query: %v", query)
				}
				if tt.mode == "drain" && query.Get("timeout_secs") != "30" {
					t.Fatalf("drain timeout: %v", query)
				}
				if tt.mode == "instant" && query.Has("timeout_secs") {
					t.Fatalf("instant timeout: %v", query)
				}
			default:
				if tt.mode != "" {
					t.Fatal("missing upstream patch")
				}
			}
		})
	}
}

func profileForTest(profiles []map[string]json.RawMessage, user, mode string) map[string]json.RawMessage {
	for _, profile := range profiles {
		if rawJSONString(profile["user"]) == user && rawJSONString(profile["secret_mode"]) == mode {
			return profile
		}
	}
	return nil
}
