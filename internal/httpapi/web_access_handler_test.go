package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"

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

func TestHandlePutTelemtUserWebAccessRequiresIfMatch(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})
	w := doRequest(t, srv, cookie, http.MethodPut, "/api/telemt/web-access/users/alice", nil, []byte(`{"profiles":[]}`))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", w.Code, w.Body)
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
