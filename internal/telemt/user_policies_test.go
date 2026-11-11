package telemt

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"testing"
)

func TestUserPolicyWirePreservation(t *testing.T) {
	for _, body := range []string{`{"username":"alice"}`, `{"username":"alice","source_deny":null}`, `{"username":"alice","source_deny":[]}`, `{"username":"alice","source_deny":["::/0"]}`} {
		var req CreateUserRequest
		if err := json.Unmarshal([]byte(body), &req); err != nil {
			t.Fatal(err)
		}
		data, _ := json.Marshal(req)
		var got, want any
		_ = json.Unmarshal(data, &got)
		_ = json.Unmarshal([]byte(body), &want)
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %s want %s", data, body)
		}
	}
	for _, body := range []string{
		`{"username":"alice","source_deny":[],"source_deny_status":{"effective":null,"runtime_reload_required":null,"apply_mode":"generation_reload","reload_endpoint":"POST /v1/system/reload","effective_scope":"request_generation_snapshot"}}`,
		`{"username":"alice","source_deny":[],"source_deny_status":{"effective":[],"runtime_reload_required":false,"apply_mode":"generation_reload","reload_endpoint":"POST /v1/system/reload","effective_scope":"request_generation_snapshot"}}`,
	} {
		var user UserInfo
		if err := json.Unmarshal([]byte(body), &user); err != nil {
			t.Fatal(err)
		}
		normalizeSlices(&user)
		data, _ := json.Marshal(user)
		var got, want map[string]json.RawMessage
		_ = json.Unmarshal(data, &got)
		_ = json.Unmarshal([]byte(body), &want)
		for _, key := range []string{"source_deny", "source_deny_status"} {
			if string(got[key]) != string(want[key]) {
				t.Errorf("%s got %s want %s", key, got[key], want[key])
			}
		}
	}
}

func TestUserSourceDenyMetadataFailuresAndDowngrade(t *testing.T) {
	for _, status := range []int{401, 503, 404} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			current := 200
			c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/v1/capabilities" {
					if current != 200 {
						w.WriteHeader(current)
						return
					}
					fmt.Fprint(w, `{"ok":true,"data":{"schema_version":1,"operations":[],"api_version":"v1","software_version":"3.5.17","config_schema":"/v1/config/schema","read_only":false,"availability_scope":"feature_and_runtime_source_prerequisites_not_request_success"}}`)
					return
				}
				if r.URL.Path == "/v1/config/schema" {
					fmt.Fprint(w, `{"ok":true,"data":{"schema_version":1,"fields":[{"path":"access.user_source_deny","api":{"request_field":"source_deny","write_routes":["POST /v1/users","PATCH /v1/users/{username}"],"config_read":false,"config_write":false,"read_routes":[],"null_behavior":"not_editable"},"sensitivity":"public"}],"value_schema_dialect":"https://json-schema.org/draft/2020-12/schema","defaults_scope":"unconfigured_type_defaults_before_loader_normalization","validation_scope":"value_constraints_are_not_a_substitute_for_full_config_validation","path_notation":"dot_members; []=array_element; {name}=dynamic_map_key","config_patch":{"objects":"recursive_merge","arrays":"replace_whole_array","object_null_members":"ignored_before_candidate_validation","reset":"not_supported","source_ownership":"one_independently_writable_source_per_mutation","if_match":"optional_source_manifest_revision"}}}`)
					return
				}
				http.NotFound(w, r)
			})
			supported, err := c.UserSourceDenySupported(context.Background())
			if err != nil || !supported {
				t.Fatalf("warm: %v %v", supported, err)
			}
			current = status
			supported, err = c.UserSourceDenySupported(context.Background())
			if supported {
				t.Fatal("trusted stale warm metadata")
			}
			if status != 404 && err == nil {
				t.Fatal("lost metadata failure")
			}
			if status == 404 && err != nil {
				t.Fatalf("unsupported: %v", err)
			}
		})
	}
}

func TestUserSourceDenyRejectsEmptyMetadata(t *testing.T) {
	for _, payload := range []string{`null`, `{}`, `{"schema_version":1}`} {
		c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprintf(w, `{"ok":true,"data":%s}`, payload) })
		supported, err := c.UserSourceDenySupported(context.Background())
		if err == nil || supported {
			t.Errorf("accepted missing metadata %s: supported=%v err=%v", payload, supported, err)
		}
	}
}
