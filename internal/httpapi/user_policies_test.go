package httpapi

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

func TestUserPolicyPatchValidation(t *testing.T) {
	for _, body := range []string{`{"typo_limit":1}`, `null`, `{"source_deny":[1]}`} {
		if _, err := decodeUserPatch([]byte(body)); err == nil {
			t.Errorf("accepted invalid patch %s", body)
		}
	}
	for _, body := range []string{`{}`, `{"source_deny":null}`, `{"source_deny":[]}`, `{"source_deny":["192.0.2.0/24"]}`} {
		patch, err := decodeUserPatch([]byte(body))
		if err != nil {
			t.Errorf("rejected %s: %v", body, err)
			continue
		}
		data, _ := json.Marshal(patch)
		if string(data) != body {
			t.Errorf("got %s want %s", data, body)
		}
	}
}

func TestUserPoliciesRejectUnsupportedAndUnknown(t *testing.T) {
	for _, tc := range []struct {
		method, path, body string
		status             int
	}{
		{"PATCH", "/api/users/alice", `{"source_deny":[]}`, 501},
		{"POST", "/api/users", `{"username":"new","source_deny":[]}`, 501},
		{"PATCH", "/api/users/alice", `{"made_up":1}`, 400},
		{"POST", "/api/users", `{"username":"new","made_up":1}`, 400},
	} {
		t.Run(tc.method+tc.body, func(t *testing.T) {
			srv, cookie := newUsersTestServer(t, newFakeTelemt(aliceFixture()), false)
			var body any
			_ = json.Unmarshal([]byte(tc.body), &body)
			rec := httptest.NewRecorder()
			srv.Handler().ServeHTTP(rec, mutatingJSON(t, tc.method, tc.path, cookie, body))
			if rec.Code != tc.status {
				t.Fatalf("got %d: %s", rec.Code, rec.Body.String())
			}
			if tc.status == 400 && !strings.Contains(rec.Body.String(), "made_up") {
				t.Errorf("missing explanatory field: %s", rec.Body.String())
			}
		})
	}
}

func TestUserPoliciesForwardAndReturn(t *testing.T) {
	for _, source := range []string{"", `,"source_deny":null`, `,"source_deny":[]`, `,"source_deny":["192.0.2.0/24"]`} {
		for _, method := range []string{"POST", "PATCH"} {
			t.Run(method+source, func(t *testing.T) {
				srv, cookie := newUsersTestServer(t, newFakeTelemt(aliceFixture()), false)
				var captured []byte
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					switch r.URL.Path {
					case "/v1/capabilities":
						fmt.Fprint(w, `{"ok":true,"data":{"schema_version":1,"operations":[],"api_version":"v1","software_version":"3.5.17","config_schema":"/v1/config/schema","read_only":false,"availability_scope":"feature_and_runtime_source_prerequisites_not_request_success"}}`)
					case "/v1/config/schema":
						fmt.Fprint(w, `{"ok":true,"data":{"schema_version":1,"fields":[{"path":"access.user_source_deny","api":{"request_field":"source_deny","write_routes":["POST /v1/users","PATCH /v1/users/{username}"],"config_read":false,"config_write":false,"read_routes":[],"null_behavior":"not_editable"},"sensitivity":"public"}],"value_schema_dialect":"https://json-schema.org/draft/2020-12/schema","defaults_scope":"unconfigured_type_defaults_before_loader_normalization","validation_scope":"value_constraints_are_not_a_substitute_for_full_config_validation","path_notation":"dot_members; []=array_element; {name}=dynamic_map_key","config_patch":{"objects":"recursive_merge","arrays":"replace_whole_array","object_null_members":"ignored_before_candidate_validation","reset":"not_supported","source_ownership":"one_independently_writable_source_per_mutation","if_match":"optional_source_manifest_revision"}}}`)
					case "/v1/users", "/v1/users/alice":
						user := `{"username":"alice","source_deny":[],"source_deny_status":{"effective":null,"runtime_reload_required":null},"limits":{"desired":{"max_tcp_conns":{"value":7,"configured_override":0,"global_value":7,"origin":"global_default"}}}}`
						if r.Method == "GET" {
							fmt.Fprintf(w, `{"ok":true,"data":[%s]}`, user)
							return
						}
						captured, _ = io.ReadAll(r.Body)
						if r.Method == "POST" {
							fmt.Fprintf(w, `{"ok":true,"data":{"user":%s,"secret":"secret"}}`, user)
						} else {
							fmt.Fprintf(w, `{"ok":true,"data":%s}`, user)
						}
					default:
						http.NotFound(w, r)
					}
				}))
				defer upstream.Close()
				srv.tc = telemt.New(upstream.URL, "")
				path := "/api/users"
				if method == "PATCH" {
					path += "/alice"
				}
				body := `{"username":"alice"` + source + `}`
				if method == "PATCH" {
					body = `{` + strings.TrimPrefix(source, ",") + `}`
				}
				var value any
				_ = json.Unmarshal([]byte(body), &value)
				rec := httptest.NewRecorder()
				srv.Handler().ServeHTTP(rec, mutatingJSON(t, method, path, cookie, value))
				if rec.Code >= 300 {
					t.Fatalf("%d %s", rec.Code, rec.Body.String())
				}
				var got, want map[string]json.RawMessage
				_ = json.Unmarshal(captured, &got)
				_ = json.Unmarshal([]byte(body), &want)
				if string(got["source_deny"]) != string(want["source_deny"]) {
					t.Fatalf("got %s want %s", captured, body)
				}
				for _, key := range []string{`"source_deny":[]`, `"effective":null`, `"configured_override":0`, `"origin":"global_default"`} {
					if !strings.Contains(rec.Body.String(), key) {
						t.Errorf("missing %s: %s", key, rec.Body.String())
					}
				}
				for _, path := range []string{"/api/users", "/api/users/alice"} {
					rec := httptest.NewRecorder()
					req := httptest.NewRequest("GET", path, nil)
					req.AddCookie(cookie)
					srv.Handler().ServeHTTP(rec, req)
					if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"source_deny_status":{"effective":null`) {
						t.Fatalf("read %s: %d %s", path, rec.Code, rec.Body.String())
					}
				}
			})
		}
	}
}

func TestUserPolicyMetadataFailureRefusesMutation(t *testing.T) {
	for _, tc := range []struct {
		status int
		code   string
	}{{401, "telemt_auth_failed"}, {503, "telemt_api_error"}, {200, "telemt_invalid_response"}} {
		t.Run(fmt.Sprint(tc.status), func(t *testing.T) {
			srv, cookie := newUsersTestServer(t, newFakeTelemt(aliceFixture()), false)
			writes := 0
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" {
					writes++
					fmt.Fprint(w, `{"ok":true,"data":{"username":"alice"}}`)
					return
				}
				if r.URL.Path == "/v1/capabilities" {
					if tc.status != 200 {
						w.WriteHeader(tc.status)
						return
					}
					fmt.Fprint(w, `{"ok":true,"data":{}}`)
					return
				}
				http.NotFound(w, r)
			}))
			defer upstream.Close()
			srv.tc = telemt.New(upstream.URL, "")
			rec := httptest.NewRecorder()
			srv.Handler().ServeHTTP(rec, mutatingJSON(t, "PATCH", "/api/users/alice", cookie, map[string]any{"source_deny": []string{}}))
			if rec.Code != 502 || !strings.Contains(rec.Body.String(), tc.code) || writes != 0 {
				t.Fatalf("status=%d body=%s writes=%d", rec.Code, rec.Body.String(), writes)
			}
		})
	}
}
