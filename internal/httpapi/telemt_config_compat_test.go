package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

func TestRetryJitterOptionalPeakVersionGuard(t *testing.T) {
	patch := map[string]json.RawMessage{"web": json.RawMessage(`{"retry_jitter":{"enabled":true,"min_ms":1,"max_ms":9,"distribution":"triangular","peak_ms":5}}`)}
	for _, version := range []string{"", "unknown", "3.5.14", "3.5.15", "3.5.16", "3.5.17"} {
		err := validateTelemtConfigPatch(patch, nil, version)
		want := version == "3.5.16" || version == "3.5.17"
		if (err == nil) != want {
			t.Errorf("%s: accepted=%v want=%v (%v)", version, err == nil, want, err)
		}
	}
	for _, version := range []string{"3.5.16", "3.5.17"} {
		fields := map[string]telemtConfigField{}
		for _, field := range telemtConfigCatalogForVersion(version).Fields {
			fields[field.Path] = field
		}
		for path, want := range map[string]string{"web.retry_jitter.enabled": "false", "web.retry_jitter.min_ms": "0", "web.retry_jitter.max_ms": "250", "web.retry_jitter.distribution": "uniform", "web.retry_jitter.peak_ms": "null"} {
			field, ok := fields[path]
			if !ok || field.DefaultValue != want || field.Apply != "runtime reload" {
				t.Errorf("%s field %s: %+v", version, path, field)
			}
		}
	}
}

func TestNewDNSAndAPICatalogPaths(t *testing.T) {
	patch := map[string]json.RawMessage{"network": json.RawMessage(`{"dns_overrides":[]}`), "server": json.RawMessage(`{"api":{"minimal_runtime_enabled":false,"minimal_runtime_cache_ttl_ms":100,"runtime_edge_enabled":true,"runtime_edge_cache_ttl_ms":50,"runtime_edge_top_n":20}}`)}
	for _, version := range []string{"unknown", "3.5.16", "3.5.17"} {
		err := validateTelemtConfigPatch(patch, nil, version)
		if (err == nil) != (version == "3.5.17") {
			t.Errorf("%s: %v", version, err)
		}
	}
}

func TestUpstreamSchemaSafePathsAndRuntimeFence(t *testing.T) {
	var patches int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/config":
			if r.Method == "PATCH" {
				patches++
				if r.Header.Get("If-Runtime-Match") != "runtime-1" {
					t.Error("runtime fence lost")
				}
				fmt.Fprint(w, `{"ok":true,"revision":"s2","data":{"revision":"s2","changed":["web"],"changed_paths":["web.future_option"]}}`)
			} else {
				fmt.Fprint(w, `{"ok":true,"revision":"s1","data":{"web":{"enabled":true},"server":{"listeners":[]}}}`)
			}
		case "/v1/config/schema":
			fmt.Fprint(w, `{"ok":true,"data":{"fields":[{"path":"web.future_option","sensitivity":"public","api":{"config_write":true,"config_read":false,"read_routes":[],"write_routes":[],"null_behavior":"not_editable"}},{"path":"server.api","sensitivity":"public","api":{"config_write":false,"config_read":false,"read_routes":[],"write_routes":[],"null_behavior":"not_editable"}},{"path":"server.api.future_safe_option","sensitivity":"public","api":{"config_write":true,"config_read":false,"read_routes":[],"write_routes":[],"null_behavior":"not_editable"}},{"path":"web.credential","sensitivity":"credential","api":{"config_write":true,"config_read":false,"read_routes":[],"write_routes":[],"null_behavior":"not_editable"}},{"path":"access.user_source_deny","sensitivity":"credential","api":{"config_write":false,"config_read":false,"read_routes":[],"write_routes":[],"null_behavior":"not_editable"}}],"schema_version":1,"value_schema_dialect":"https://json-schema.org/draft/2020-12/schema","defaults_scope":"unconfigured_type_defaults_before_loader_normalization","validation_scope":"value_constraints_are_not_a_substitute_for_full_config_validation","path_notation":"dot_members; []=array_element; {name}=dynamic_map_key","config_patch":{"objects":"recursive_merge","arrays":"replace_whole_array","object_null_members":"ignored_before_candidate_validation","reset":"not_supported","source_ownership":"one_independently_writable_source_per_mutation","if_match":"optional_source_manifest_revision"}}}`)
		case "/v1/capabilities":
			http.NotFound(w, r)
		case "/v1/system/info":
			fmt.Fprint(w, `{"version":"future"}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	srv, cookie := newTelemtInfoTestServer(t, telemt.New(upstream.URL, ""))
	for _, body := range []string{`{"sections":{"web":{"future_option":42}}}`, `{"sections":{"server":{"api":{"future_safe_option":true}}}}`} {
		w := doRequest(t, srv, cookie, "PATCH", "/api/telemt/config", map[string]string{"If-Match": "s1", "If-Runtime-Match": "runtime-1"}, []byte(body))
		if w.Code != 200 {
			t.Errorf("schema path rejected: %d %s", w.Code, w.Body)
		}
	}
	for _, body := range []string{`{"sections":{"web":{"credential":"bad"}}}`, `{"sections":{"access":{"user_source_deny":{}}}}`, `{"sections":{"server":{"api":{"auth_header":"bad"}}}}`} {
		before := patches
		w := doRequest(t, srv, cookie, "PATCH", "/api/telemt/config", map[string]string{"If-Match": "s1"}, []byte(body))
		if w.Code != 400 || patches != before {
			t.Errorf("unsafe schema field admitted: %d %s", w.Code, w.Body)
		}
	}
}

func TestTOMLPreviewUsesNonMutatingPreflight(t *testing.T) {
	var writes, preflights int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/config":
			if r.Method == "PATCH" {
				writes++
			}
			fmt.Fprint(w, `{"ok":true,"revision":"s1","data":{"web":{"enabled":true}}}`)
		case "/v1/config/validate":
			preflights++
			if r.Header.Get("If-Match") != "s1" || r.Header.Get("If-Runtime-Match") != "r1" || r.URL.Query().Get("reload") != "instant" {
				t.Error("preview preconditions lost")
			}
			fmt.Fprint(w, `{"ok":true,"revision":"s1","data":{"valid":true,"base_revision":"s1","candidate_revision":"s2","runtime":{"runtime_match":"r1"},"changed_paths":["web.enabled"]}}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	srv, cookie := newTelemtInfoTestServer(t, telemt.New(upstream.URL, ""))
	w := doRequest(t, srv, cookie, "POST", "/api/telemt/config/toml/preview?reload=instant", map[string]string{"If-Match": "s1", "If-Runtime-Match": "r1"}, []byte(`{"toml_projection":"[web]\nenabled = false\n"}`))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"validation":{"valid":true`) || !strings.Contains(w.Body.String(), `"runtime_match":"r1"`) {
		t.Errorf("preview preflight missing: %d %s", w.Code, w.Body)
	}
	if writes != 0 || preflights != 1 {
		t.Errorf("writes=%d preflights=%d", writes, preflights)
	}
}

func TestSchemaPreservesAuthoredEditableUpstreamCredentials(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/config/schema" {
			fmt.Fprint(w, `{"ok":true,"data":{"fields":[{"path":"upstreams[].password","sensitivity":"credential","api":{"config_write":true,"config_read":false,"read_routes":[],"write_routes":[],"null_behavior":"not_editable"}},{"path":"web.new_secret","sensitivity":"credential","api":{"config_write":true,"config_read":false,"read_routes":[],"write_routes":[],"null_behavior":"not_editable"}}],"schema_version":1,"value_schema_dialect":"https://json-schema.org/draft/2020-12/schema","defaults_scope":"unconfigured_type_defaults_before_loader_normalization","validation_scope":"value_constraints_are_not_a_substitute_for_full_config_validation","path_notation":"dot_members; []=array_element; {name}=dynamic_map_key","config_patch":{"objects":"recursive_merge","arrays":"replace_whole_array","object_null_members":"ignored_before_candidate_validation","reset":"not_supported","source_ownership":"one_independently_writable_source_per_mutation","if_match":"optional_source_manifest_revision"}}}`)
			return
		}
		http.NotFound(w, r)
	}))
	defer upstream.Close()
	srv, _ := newTelemtInfoTestServer(t, telemt.New(upstream.URL, ""))
	patch := map[string]json.RawMessage{"upstreams": json.RawMessage(`[{"type":"socks5","address":"proxy.internal:1080","password":"authored-secret"}]`)}
	if err := srv.validateTelemtConfigPatchWithSchema(t.Context(), patch, nil, "3.5.17"); err != nil {
		t.Fatalf("authored editable credential rejected: %v", err)
	}
	if err := srv.validateTelemtConfigPatchWithSchema(t.Context(), map[string]json.RawMessage{"web": json.RawMessage(`{"new_secret":"no"}`)}, nil, "3.5.17"); err == nil {
		t.Fatal("schema introduced unknown credential path")
	}
}

func TestUnchangedTOMLPreviewDoesNotSubmitEmptyPreflight(t *testing.T) {
	var preflights int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/config":
			fmt.Fprint(w, `{"ok":true,"revision":"s1","data":{"web":{"enabled":true}}}`)
		case "/v1/config/validate":
			preflights++
			w.WriteHeader(400)
			fmt.Fprint(w, `{"ok":false,"error":{"code":"bad_request","message":"empty patch: no editable sections"}}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	srv, cookie := newTelemtInfoTestServer(t, telemt.New(upstream.URL, ""))
	w := doRequest(t, srv, cookie, "POST", "/api/telemt/config/toml/preview", map[string]string{"If-Match": "s1"}, []byte(`{"toml_projection":"[web]\nenabled = true\n"}`))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"patch":{}`) {
		t.Fatalf("unchanged preview regressed: %d %s", w.Code, w.Body)
	}
	if preflights != 0 {
		t.Fatalf("empty preflight submissions=%d", preflights)
	}
}
