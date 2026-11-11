package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

func TestOptionalConfigContracts(t *testing.T) {
	var writes, preflights int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/capabilities":
			w.Write([]byte(`{"ok":true,"data":{"read_only":true,"operations":[{"id":"config_validate","method":"POST","path":"/v1/config/validate","supported":true,"enabled":true,"read_only_operation":true}],"api_version":"v1","schema_version":1,"software_version":"3.5.17","config_schema":"/v1/config/schema","availability_scope":"feature_and_runtime_source_prerequisites_not_request_success"}}`))
		case "/v1/config/schema":
			w.Write([]byte(`{"ok":true,"data":{"schema_version":1,"fields":[{"path":"web.retry_jitter.peak_ms","sensitivity":"public","api":{"config_write":true,"config_read":false,"read_routes":[],"write_routes":[],"null_behavior":"not_editable"}}],"value_schema_dialect":"https://json-schema.org/draft/2020-12/schema","defaults_scope":"unconfigured_type_defaults_before_loader_normalization","validation_scope":"value_constraints_are_not_a_substitute_for_full_config_validation","path_notation":"dot_members; []=array_element; {name}=dynamic_map_key","config_patch":{"objects":"recursive_merge","arrays":"replace_whole_array","object_null_members":"ignored_before_candidate_validation","reset":"not_supported","source_ownership":"one_independently_writable_source_per_mutation","if_match":"optional_source_manifest_revision"}}}`))
		case "/v1/config/state":
			w.Write([]byte(`{"ok":true,"revision":null,"data":{"desired_revision":null,"runtime":{"runtime_match":"g1-e2"},"comparison":{"status":"unknown"}}}`))
		case "/v1/config/validate":
			preflights++
			if r.Header.Get("If-Match") != "source-1" || r.Header.Get("If-Runtime-Match") != "runtime-1" || r.URL.Query().Get("reload") != "instant" {
				t.Errorf("preconditions/query lost: %+v", r)
			}
			var body map[string]json.RawMessage
			json.NewDecoder(r.Body).Decode(&body)
			if string(body["web"]) != `{"enabled":true}` {
				t.Errorf("patch = %v", body)
			}
			w.Write([]byte(`{"ok":true,"revision":"source-1","data":{"valid":true,"base_revision":"source-1","candidate_revision":"source-2","runtime":{"runtime_match":"runtime-1"},"changed_paths":["web.enabled"],"normalization_effects":[]}}`))
		case "/v1/config":
			if r.Method == "PATCH" {
				writes++
			}
			w.Write([]byte(`{"ok":true,"revision":"source-1","data":{"web":{"enabled":false}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	srv, cookie := newTelemtInfoTestServer(t, telemt.New(upstream.URL, ""))
	for _, path := range []string{"capabilities", "config/schema", "config/state"} {
		w := doRequest(t, srv, cookie, "GET", "/api/telemt/"+path, nil, nil)
		if w.Code != 200 {
			t.Errorf("%s: %d %s", path, w.Code, w.Body)
		}
		if path == "config/state" && !strings.Contains(w.Body.String(), `"revision":null`) {
			t.Errorf("nullable revision lost: %s", w.Body)
		}
	}
	w := doRequest(t, srv, cookie, "POST", "/api/telemt/config/validate?reload=instant", map[string]string{"If-Match": "source-1", "If-Runtime-Match": "runtime-1"}, []byte(`{"sections":{"web":{"enabled":true}}}`))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"candidate_revision":"source-2"`) {
		t.Fatalf("validate: %d %s", w.Code, w.Body)
	}
	if writes != 0 || preflights != 1 {
		t.Fatalf("writes=%d preflights=%d", writes, preflights)
	}
}

func TestOptionalConfigUnsupportedAndDetailedErrors(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/config/validate" {
			w.WriteHeader(422)
			w.Write([]byte(`{"ok":false,"error":{"code":"validation_failed","message":"invalid","details":[{"path":"web.retry_jitter.peak_ms","code":"range","message":"outside range"}]}}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer upstream.Close()
	srv, cookie := newTelemtInfoTestServer(t, telemt.New(upstream.URL, ""))
	w := doRequest(t, srv, cookie, "GET", "/api/telemt/config/state", nil, nil)
	if w.Code != 501 || !strings.Contains(w.Body.String(), "capability_absent") {
		t.Errorf("unsupported: %d %s", w.Code, w.Body)
	}
	w = doRequest(t, srv, cookie, "POST", "/api/telemt/config/validate", map[string]string{"If-Match": "s1"}, []byte(`{"sections":{"web":{"enabled":true}}}`))
	if w.Code != 422 || !strings.Contains(w.Body.String(), `"path":"web.retry_jitter.peak_ms"`) {
		t.Errorf("details: %d %s", w.Code, w.Body)
	}
}
