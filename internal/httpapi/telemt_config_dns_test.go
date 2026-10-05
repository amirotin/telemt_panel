package httpapi

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestTelemtConfigDNSIntroduction(t *testing.T) {
	paths := []string{"web.vhosts[].decoy.resolve", "web.timeouts.decoy_resolve_secs"}
	for _, version := range []string{"", "unknown", "3.5.7", "3.5.13", "3.5.14", "3.6.0"} {
		t.Run(version, func(t *testing.T) {
			fields := map[string]telemtConfigField{}
			for _, field := range telemtConfigCatalogForVersion(version).Fields {
				fields[field.Path] = field
			}
			want := version == "3.5.14" || version == "3.6.0"
			for _, path := range paths {
				if _, got := fields[path]; got != want {
					t.Errorf("%s offered=%v, want %v", path, got, want)
				}
			}
			if want {
				resolve := fields[paths[0]]
				if resolve.DefaultValue != "never" || !reflect.DeepEqual(resolve.Options, []string{"never", "startup"}) {
					t.Errorf("DNS policy=%+v", resolve)
				}
				if fields[paths[1]].DefaultValue != "5" {
					t.Error("DNS timeout default must be 5 seconds")
				}
			}
		})
	}
	patch := map[string]json.RawMessage{"web": json.RawMessage(`{"vhosts":[{"decoy":{"mode":"http_upstream","upstream":"http://backend.internal:8080","resolve":"startup"}}],"timeouts":{"decoy_resolve_secs":5}}`)}
	if err := validateTelemtConfigPatch(patch, nil, "3.5.14"); err != nil {
		t.Fatalf("3.5.14 rejected DNS settings: %v", err)
	}
	if err := validateTelemtConfigPatch(patch, nil, "3.5.13"); err == nil {
		t.Fatal("DNS settings must not reach an older server")
	}
}
