package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/amirotin/telemt_panel/internal/telemt"
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

func TestCatalog358ExposesAuditedNewFieldsWithoutChangingLegacy(t *testing.T) {
	current := telemtConfigCatalogForVersion("3.5.8")
	paths := make(map[string]telemtConfigField)
	for _, field := range current.Fields {
		paths[field.Path] = field
	}
	for _, path := range []string{"web.vhosts[].base_path", "web.debug.sideband", "general.me_reinit_max_concurrency", "web.decoy_fasttrack_mode", "web.http_connection_capacity_action", "web.limits.max_http_overload_connections", "web.timeouts.bridge_recovery_secs", "web.timeouts.http_overload_timeout_ms"} {
		if _, ok := paths[path]; !ok {
			t.Fatalf("missing 3.5.8 setting %s", path)
		}
	}
	if paths["general.direct_relay_buffer_budget_max_bytes"].Apply != "process restart" {
		t.Fatal("3.5.8 process-owned buffer budget must not promise reload")
	}
	for _, version := range []string{"3.5.5", "3.5.7", "unknown", ""} {
		legacy := telemtConfigCatalogForVersion(version)
		for _, field := range legacy.Fields {
			if field.Path == "web.vhosts[].base_path" {
				t.Fatalf("3.5.8 path offered on %s", version)
			}
		}
	}
}

func Test358ConfigPatchCanMaterializeAbsentWebButLegacyCannot(t *testing.T) {
	patch := map[string]json.RawMessage{"web": json.RawMessage(`{"enabled":false,"vhosts":[{"host":"web.example.org","base_path":"Relay/app","public_addr":"203.0.113.1:443","decoy":{"mode":"http_upstream","upstream":"http://127.0.0.1:8080"},"profiles":[]}],"debug":{"sideband":false}}`)}
	if err := validateTelemtConfigPatch(patch, nil, "3.5.8"); err != nil {
		t.Fatalf("3.5.8 rejected known absent sections: %v", err)
	}
	if err := validateTelemtConfigPatch(patch, nil, "3.5.5"); err == nil {
		t.Fatal("legacy API must not silently discard the new fields")
	}
}

func TestTelemtConfigCatalogReleaseMilestones(t *testing.T) {
	for _, tt := range []struct {
		version string
		catalog string
		commit  string
		fields  int
	}{
		{"", "3.5.5", "ac71d92ec41dea00a7eafd6b8d350c3486633500", 341},
		{"unknown", "3.5.5", "ac71d92ec41dea00a7eafd6b8d350c3486633500", 341},
		{"3.5.5", "3.5.5", "ac71d92ec41dea00a7eafd6b8d350c3486633500", 341},
		{"3.5.6", "3.5.6", "3693d1e2a87af0074598104338b5a4bb5bee202d", 347},
		{"3.5.7", "3.5.6", "3693d1e2a87af0074598104338b5a4bb5bee202d", 347},
		{"3.5.8", "3.5.8", "717a34771f1403ecd06c3ce0a33c955a269c389f", 349},
		{"3.5.9", "3.5.8", "717a34771f1403ecd06c3ce0a33c955a269c389f", 349},
		{"3.5.10", "3.5.8", "717a34771f1403ecd06c3ce0a33c955a269c389f", 349},
		{"3.5.11", "3.5.8", "717a34771f1403ecd06c3ce0a33c955a269c389f", 349},
		{"3.5.12", "3.5.12", "c4555e25f39dd5be200ccf6353f7d82bfcf89131", 350},
		{"3.5.13", "3.5.13", "d3de9865cf5d088809fdf728059bcb2b0841db67", 351},
		{"3.6.0", "3.5.13", "d3de9865cf5d088809fdf728059bcb2b0841db67", 351},
	} {
		t.Run(tt.version, func(t *testing.T) {
			catalog := telemtConfigCatalogForVersion(tt.version)
			if catalog.Version != tt.catalog || catalog.SourceCommit != tt.commit {
				t.Errorf("catalog source = %s/%s, want %s/%s", catalog.Version, catalog.SourceCommit, tt.catalog, tt.commit)
			}
			if len(catalog.Fields) != tt.fields || catalog.DocumentedFields != tt.fields-1 {
				t.Errorf("field counts = %d/%d, want %d/%d", len(catalog.Fields), catalog.DocumentedFields, tt.fields, tt.fields-1)
			}
			paths := make(map[string]bool, len(catalog.Fields))
			for _, field := range catalog.Fields {
				if paths[field.Path] {
					t.Errorf("duplicate config field %s", field.Path)
				}
				paths[field.Path] = true
			}
		})
	}
}

func TestTelemtConfigPatchFieldsFollowIntroductionVersion(t *testing.T) {
	for _, tt := range []struct {
		path    string
		before  string
		since   string
		section string
		patch   string
	}{
		{"general.me_reinit_max_concurrency", "3.5.5", "3.5.6", "general", `{"me_reinit_max_concurrency":2}`},
		{"web.decoy_fasttrack_mode", "3.5.5", "3.5.6", "web", `{"decoy_fasttrack_mode":"off"}`},
		{"web.http_connection_capacity_action", "3.5.5", "3.5.6", "web", `{"http_connection_capacity_action":"wait"}`},
		{"web.limits.max_http_overload_connections", "3.5.5", "3.5.6", "web", `{"limits":{"max_http_overload_connections":64}}`},
		{"web.timeouts.bridge_recovery_secs", "3.5.5", "3.5.6", "web", `{"timeouts":{"bridge_recovery_secs":15}}`},
		{"web.timeouts.http_overload_timeout_ms", "3.5.5", "3.5.6", "web", `{"timeouts":{"http_overload_timeout_ms":250}}`},
		{"web.debug.sideband", "3.5.7", "3.5.8", "web", `{"debug":{"sideband":false}}`},
		{"web.vhosts[].base_path", "3.5.7", "3.5.8", "web", `{"vhosts":[{"base_path":"relay/app"}]}`},
		{"web.carrier_method", "3.5.11", "3.5.12", "web", `{"carrier_method":"put"}`},
		{"web.conveyor", "3.5.12", "3.5.13", "web", `{"conveyor":false}`},
	} {
		t.Run(tt.path, func(t *testing.T) {
			patch := map[string]json.RawMessage{tt.section: json.RawMessage(tt.patch)}
			if err := validateTelemtConfigPatch(patch, nil, tt.before); err == nil {
				t.Errorf("%s accepted a field introduced in %s", tt.before, tt.since)
			}
			for _, version := range []string{tt.since, "3.5.13"} {
				if err := validateTelemtConfigPatch(patch, nil, version); err != nil {
					t.Errorf("%s rejected a supported field in absent config: %v", version, err)
				}
			}
		})
	}
}

func TestTelemtConfigCatalogLatestWebPolicy(t *testing.T) {
	for _, tt := range []struct {
		path         string
		kind         string
		defaultValue string
		options      []string
	}{
		{"web.carrier_method", "enum", "post", []string{"post", "put"}},
		{"web.conveyor", "boolean", "true", nil},
	} {
		t.Run(tt.path, func(t *testing.T) {
			for _, field := range telemtConfigCatalogForVersion("3.5.13").Fields {
				if field.Path != tt.path {
					continue
				}
				if field.Kind != tt.kind || field.DefaultValue != tt.defaultValue || !reflect.DeepEqual(field.Options, tt.options) {
					t.Errorf("field policy = %+v", field)
				}
				if field.Apply != "runtime reload" || !field.DocHot || field.Group != "web" || field.Tier != "normal" {
					t.Errorf("field presentation/reload = %+v", field)
				}
				return
			}
			t.Fatal("WEB policy field is missing")
		})
	}
}

func TestTelemtConfigCatalogCorrectsDefaultWithoutMutatingBaseline(t *testing.T) {
	baseline, err := json.Marshal(telemt355ConfigCatalog)
	if err != nil {
		t.Fatal(err)
	}
	for _, version := range []string{"3.5.13", "3.5.5", "3.5.6", "3.5.8", "unknown"} {
		found := false
		for _, field := range telemtConfigCatalogForVersion(version).Fields {
			if field.Path == "general.me_bind_stale_mode" {
				found = true
				if field.DefaultValue != `"never"` {
					t.Errorf("%s stale-bind default = %q, want never", version, field.DefaultValue)
				}
			}
			if field.Path == "general.direct_relay_buffer_budget_max_bytes" {
				wantApply := "runtime reload"
				if version == "3.5.8" || version == "3.5.13" {
					wantApply = "process restart"
				}
				if field.Apply != wantApply {
					t.Errorf("%s buffer budget apply = %q, want %q", version, field.Apply, wantApply)
				}
			}
		}
		if !found {
			t.Errorf("%s stale-bind policy missing", version)
		}
	}
	current, err := json.Marshal(telemt355ConfigCatalog)
	if err != nil {
		t.Fatal(err)
	}
	if string(current) != string(baseline) {
		t.Fatal("version selection mutated the shared legacy catalog")
	}
}

func TestTelemtConfigNewWebSnapshotAllowsPatchWithUnknownVersion(t *testing.T) {
	snapshot := telemt.ConfigSections{"web": json.RawMessage(`{"carrier_method":"post","conveyor":true}`)}
	patch := map[string]json.RawMessage{"web": json.RawMessage(`{"carrier_method":"put","conveyor":false}`)}
	if err := validateTelemtConfigPatch(patch, snapshot, "unknown"); err != nil {
		t.Fatalf("server-exposed fields rejected when version lookup is unavailable: %v", err)
	}
}
