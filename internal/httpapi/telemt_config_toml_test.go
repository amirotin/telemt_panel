package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/amirotin/telemt_panel/internal/telemt"
	"github.com/amirotin/telemt_panel/internal/telemt/telemttest"
)

func getTOMLProjection(t *testing.T, srv *Server, cookie *http.Cookie) telemtConfigTOMLView {
	t.Helper()
	w := doRequest(t, srv, cookie, http.MethodGet, "/api/telemt/config/toml", nil, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("GET TOML status = %d: %s", w.Code, w.Body)
	}
	var view telemtConfigTOMLView
	if err := json.Unmarshal(w.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode TOML view: %v", err)
	}
	return view
}

func tomlRequestBody(t *testing.T, projection string) []byte {
	t.Helper()
	body, err := json.Marshal(telemtConfigTOMLRequest{TOMLProjection: projection})
	if err != nil {
		t.Fatalf("encode TOML request: %v", err)
	}
	return body
}

func TestHandleGetTelemtConfigTOML_Projection(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})
	view := getTOMLProjection(t, srv, cookie)

	for _, fragment := range []string{"[general]", "[web.limits]", "max_sessions_global = 128", "request_body_limit_bytes = 65536"} {
		if !strings.Contains(view.TOMLProjection, fragment) {
			t.Errorf("projection does not contain %q:\n%s", fragment, view.TOMLProjection)
		}
	}
	if view.Revision == "" || len(view.SourceSections) == 0 || view.Note != telemtTOMLProjectionNote {
		t.Errorf("incomplete projection metadata: %+v", view)
	}
}

func TestEncodeTelemtConfigTOML_PreservesIntegerBeyondJavaScriptSafeRange(t *testing.T) {
	projection, err := encodeTelemtConfigTOML(telemt.ConfigSections{
		"general": json.RawMessage(`{"request_body_limit_bytes":9007199254740993}`),
	})
	if err != nil {
		t.Fatalf("encode projection: %v", err)
	}
	if !strings.Contains(projection, "9007199254740993") {
		t.Fatalf("projection lost integer precision: %s", projection)
	}
}

func TestHandlePreviewTelemtConfigTOML_SparseNestedPatch(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})
	view := getTOMLProjection(t, srv, cookie)
	edited := strings.Replace(view.TOMLProjection, "max_sessions_global = 128", "max_sessions_global = 256", 1)

	w := doRequest(t, srv, cookie, http.MethodPost, "/api/telemt/config/toml/preview", map[string]string{"If-Match": view.Revision}, tomlRequestBody(t, edited))
	if w.Code != http.StatusOK {
		t.Fatalf("preview status = %d: %s", w.Code, w.Body)
	}
	var preview telemtConfigTOMLPreview
	if err := json.Unmarshal(w.Body.Bytes(), &preview); err != nil {
		t.Fatalf("decode preview: %v", err)
	}
	if len(preview.ChangedPaths) != 1 || preview.ChangedPaths[0] != "web.limits.max_sessions_global" {
		t.Errorf("changed paths = %v", preview.ChangedPaths)
	}
	if len(preview.MaterializedSections) != 0 || len(preview.ArrayReplacements) != 0 {
		t.Errorf("unexpected side effects: materialized=%v arrays=%v", preview.MaterializedSections, preview.ArrayReplacements)
	}
	if got := string(preview.Patch["web"]); got != `{"limits":{"max_sessions_global":256}}` {
		t.Errorf("patch.web = %s", got)
	}
}

func TestHandlePreviewTelemtConfigTOML_MaterializesAndMarksArray(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})
	view := getTOMLProjection(t, srv, cookie)
	edited := view.TOMLProjection + "\n[[upstreams]]\ntype = \"direct\"\nenabled = true\n"

	w := doRequest(t, srv, cookie, http.MethodPost, "/api/telemt/config/toml/preview", map[string]string{"If-Match": view.Revision}, tomlRequestBody(t, edited))
	if w.Code != http.StatusOK {
		t.Fatalf("preview status = %d: %s", w.Code, w.Body)
	}
	var preview telemtConfigTOMLPreview
	if err := json.Unmarshal(w.Body.Bytes(), &preview); err != nil {
		t.Fatalf("decode preview: %v", err)
	}
	if !slicesEqual(preview.MaterializedSections, []string{"upstreams"}) {
		t.Errorf("materialized = %v", preview.MaterializedSections)
	}
	if !slicesEqual(preview.ArrayReplacements, []string{"upstreams"}) {
		t.Errorf("arrays = %v", preview.ArrayReplacements)
	}
}

func TestHandlePreviewTelemtConfigTOML_RejectsUnsetAndUnknownPath(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})
	view := getTOMLProjection(t, srv, cookie)

	tests := []struct {
		name       string
		projection string
		code       string
	}{
		{name: "unset", projection: strings.Replace(view.TOMLProjection, "log_level = \"info\"\n", "", 1), code: "config_unset_unsupported"},
		{name: "unknown", projection: view.TOMLProjection + "\n[general.typo]\nvalue = 1\n", code: "invalid_config_path"},
		{name: "invalid TOML", projection: view.TOMLProjection + "\n[broken", code: "invalid_toml"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := doRequest(t, srv, cookie, http.MethodPost, "/api/telemt/config/toml/preview", map[string]string{"If-Match": view.Revision}, tomlRequestBody(t, tt.projection))
			if w.Code != http.StatusBadRequest || !bytes.Contains(w.Body.Bytes(), []byte(tt.code)) {
				t.Fatalf("status/body = %d %s, want 400 %s", w.Code, w.Body, tt.code)
			}
		})
	}
}

func TestHandlePatchTelemtConfigTOML_AppliesAndPreserves202(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})
	view := getTOMLProjection(t, srv, cookie)
	edited := strings.Replace(view.TOMLProjection, "log_level = \"info\"", "log_level = \"debug\"", 1)

	w := doRequest(t, srv, cookie, http.MethodPatch, "/api/telemt/config/toml?reload=instant", map[string]string{"If-Match": view.Revision}, tomlRequestBody(t, edited))
	if w.Code != http.StatusAccepted {
		t.Fatalf("PATCH TOML status = %d, want 202: %s", w.Code, w.Body)
	}
	entries, err := srv.st.ListAudit(0)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	found := false
	for _, entry := range entries {
		if entry.Action == "config.patch.toml" {
			found = true
			break
		}
	}
	if !found {
		t.Error("config.patch.toml audit entry missing")
	}
}

func TestHandlePreviewTelemtConfigTOML_RevisionConflict(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})
	view := getTOMLProjection(t, srv, cookie)
	w := doRequest(t, srv, cookie, http.MethodPost, "/api/telemt/config/toml/preview", map[string]string{"If-Match": "stale"}, tomlRequestBody(t, view.TOMLProjection))
	if w.Code != http.StatusConflict || !bytes.Contains(w.Body.Bytes(), []byte("revision_conflict")) {
		t.Fatalf("status/body = %d %s", w.Code, w.Body)
	}
}

func slicesEqual(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}
