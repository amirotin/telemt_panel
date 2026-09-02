package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTelemtConfigCatalogCompleteness(t *testing.T) {
	if got, want := len(telemt355ConfigCatalog.Fields), 341; got != want {
		t.Fatalf("catalog fields = %d, want %d", got, want)
	}
	if got, want := telemt355ConfigCatalog.DocumentedFields, 340; got != want {
		t.Fatalf("documented fields = %d, want %d", got, want)
	}

	paths := make(map[string]struct{}, len(telemt355ConfigCatalog.Fields))
	normal := 0
	advanced := 0
	for _, field := range telemt355ConfigCatalog.Fields {
		if _, exists := paths[field.Path]; exists {
			t.Fatalf("duplicate catalog path %q", field.Path)
		}
		paths[field.Path] = struct{}{}
		switch field.Tier {
		case "normal":
			normal++
		case "advanced":
			advanced++
		default:
			t.Fatalf("unknown tier %q for %s", field.Tier, field.Path)
		}
	}

	if normal != 76 || advanced != 265 {
		t.Fatalf("tier counts normal=%d advanced=%d, want 76/265", normal, advanced)
	}
	for _, path := range []string{
		"general.modes.classic",
		"general.modes.secure",
		"general.modes.tls",
		"general.fast_mode",
		"general.me2dc_fallback",
		"general.use_middle_proxy",
		"general.middle_proxy_nat_probe",
		"general.middle_proxy_pool_size",
		"general.middle_proxy_warm_standby",
	} {
		var apply string
		for _, field := range telemt355ConfigCatalog.Fields {
			if field.Path == path {
				apply = field.Apply
				break
			}
		}
		if apply != "process restart" {
			t.Fatalf("catalog apply for %s = %q, want process restart", path, apply)
		}
	}
	if _, ok := paths["censorship.exclusive_mask"]; !ok {
		t.Fatal("runtime field censorship.exclusive_mask is missing")
	}
	if len(telemt355ConfigPaths) != len(paths) {
		t.Fatalf("validator paths = %d, catalog paths = %d", len(telemt355ConfigPaths), len(paths))
	}
}

func TestHandleGetTelemtConfigCatalog(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/telemt/config/catalog", nil)
	new(Server).handleGetTelemtConfigCatalog(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	var catalog telemtConfigCatalog
	if err := json.Unmarshal(recorder.Body.Bytes(), &catalog); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if catalog.Version != "3.5.5" || len(catalog.Fields) != 341 {
		t.Fatalf("unexpected catalog response: version=%q fields=%d", catalog.Version, len(catalog.Fields))
	}
}
