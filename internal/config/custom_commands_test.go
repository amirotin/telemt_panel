package config

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/BurntSushi/toml"
	"github.com/amirotin/telemt_panel/internal/host"
)

const customCommandsTOML = `
[host]
telemt_service = "telemt-custom"
panel_service = "panel-custom"

[host.commands.telemt]
start = ["/opt/etc/init.d/S99telemt", "start", "literal space", "$(not-a-shell)"]
stop = ["/opt/etc/init.d/S99telemt", "stop"]
restart = ["/opt/etc/init.d/S99telemt", "restart"]

[host.commands.panel]
restart = ["/opt/etc/init.d/S99telemt-panel", "restart"]
`

func TestLoadValidatesOptionalPanelLifecycleCommands(t *testing.T) {
	for _, action := range []string{"start", "stop"} {
		t.Run(action, func(t *testing.T) {
			content := minimal + customCommandsTOML + action + ` = ["relative-script", "` + action + `"]` + "\n"
			_, err := load(t, content)
			if err == nil || !strings.Contains(err.Error(), "host.commands.panel."+action) || !strings.Contains(err.Error(), "absolute clean path") {
				t.Fatalf("expected validation of panel %s command, got %v", action, err)
			}
		})
	}
}

func TestLoadOptionalPanelLifecycleCommands(t *testing.T) {
	content := minimal + customCommandsTOML + `
start = ["/opt/etc/init.d/S99telemt-panel", "start"]
stop = ["/opt/etc/init.d/S99telemt-panel", "stop"]
`
	if _, err := load(t, content); err != nil {
		t.Fatal(err)
	}
}

func TestLoadCustomCommandsSelectsCustomAndPreservesArgv(t *testing.T) {
	cfg, err := load(t, minimal+customCommandsTOML)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Host.ServiceManager != host.KindCustom {
		t.Fatalf("service manager = %q, want custom", cfg.Host.ServiceManager)
	}
	want := host.CustomCommands{
		Telemt: host.TelemtCommands{
			Start:   []string{"/opt/etc/init.d/S99telemt", "start", "literal space", "$(not-a-shell)"},
			Stop:    []string{"/opt/etc/init.d/S99telemt", "stop"},
			Restart: []string{"/opt/etc/init.d/S99telemt", "restart"},
		},
		Panel: host.PanelCommands{Restart: []string{"/opt/etc/init.d/S99telemt-panel", "restart"}},
	}
	if !reflect.DeepEqual(cfg.Host.Commands, want) {
		t.Fatalf("commands = %#v, want %#v", cfg.Host.Commands, want)
	}

	var encoded bytes.Buffer
	if err := toml.NewEncoder(&encoded).Encode(cfg); err != nil {
		t.Fatal(err)
	}
	roundTrip, err := decode(encoded.Bytes(), "round-trip.toml")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(roundTrip.Host.Commands, want) {
		t.Fatalf("round-trip commands = %#v, want %#v", roundTrip.Host.Commands, want)
	}
}

func TestLoadValidatesCustomCommandBindings(t *testing.T) {
	complete := minimal + customCommandsTOML
	cases := []struct {
		name    string
		content string
		field   string
	}{
		{
			name: "explicit custom incomplete",
			content: minimal + `
[host]
service_manager = "custom"
[host.commands.telemt]
start = ["/bin/true"]
`,
			field: "host.commands.telemt.stop",
		},
		{
			name:    "native manager conflicts",
			content: strings.Replace(customCommandsTOML, "[host]\n", "[host]\nservice_manager = \"systemd\"\n", 1) + minimal,
			field:   "host.commands",
		},
		{
			name:    "relative executable",
			content: strings.Replace(complete, "/opt/etc/init.d/S99telemt\", \"start", "relative-script\", \"start", 1),
			field:   "host.commands.telemt.start",
		},
		{
			name:    "unclean executable",
			content: strings.Replace(complete, "/opt/etc/init.d/S99telemt\", \"start", "/opt/etc/init.d/../S99telemt\", \"start", 1),
			field:   "host.commands.telemt.start",
		},
		{
			name:    "line break argument",
			content: strings.Replace(complete, "\"literal space\"", "\"literal space\\nPRIVATE\"", 1),
			field:   "host.commands.telemt.start",
		},
		{
			name:    "same target binding",
			content: strings.Replace(complete, "panel_service = \"panel-custom\"", "panel_service = \"telemt-custom\"", 1),
			field:   "host.panel_service",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := load(t, tc.content)
			if err == nil || !strings.Contains(err.Error(), tc.field) {
				t.Fatalf("error = %v, want field %q", err, tc.field)
			}
			if strings.Contains(err.Error(), "PRIVATE") {
				t.Fatalf("error leaked command argument: %v", err)
			}
		})
	}
}

func TestLoadBoundsCustomCommandArgv(t *testing.T) {
	tooMany := make([]string, 65)
	for i := range tooMany {
		tooMany[i] = "x"
	}
	tooMany[0] = "/bin/true"
	for _, tc := range []struct {
		name string
		argv []string
	}{
		{name: "too many elements", argv: tooMany},
		{name: "oversized argument", argv: []string{"/bin/true", strings.Repeat("x", 4097)}},
		{name: "oversized total", argv: []string{"/bin/true", strings.Repeat("a", 4096), strings.Repeat("b", 4096), strings.Repeat("c", 4096), strings.Repeat("d", 4096)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var encoded bytes.Buffer
			document := map[string]any{
				"telemt": map[string]any{"url": "http://127.0.0.1:9091"},
				"auth":   map[string]any{"disabled": true},
				"host": map[string]any{
					"service_manager": "custom",
					"telemt_service":  "telemt",
					"panel_service":   "panel",
					"commands": map[string]any{
						"telemt": host.TelemtCommands{Start: tc.argv, Stop: []string{"/bin/true"}, Restart: []string{"/bin/true"}},
						"panel":  host.PanelCommands{Restart: []string{"/bin/true"}},
					},
				},
			}
			if err := toml.NewEncoder(&encoded).Encode(document); err != nil {
				t.Fatal(err)
			}
			_, err := load(t, encoded.String())
			if err == nil || !strings.Contains(err.Error(), "host.commands.telemt.start") {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestSourceReportDescribesCustomManagerWithoutExposingArgv(t *testing.T) {
	source, err := DecodeSource([]byte(sourceFixture(t, false)+customCommandsTOML), "custom.toml", "auto")
	if err != nil {
		t.Fatal(err)
	}
	report := source.Report()
	if report.ServiceManager != host.KindCustom || report.TelemtServiceScript != "S99telemt" || report.PanelServiceScript != "S99telemt-panel" {
		t.Fatalf("report = %+v", report)
	}
	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{"literal space", "$(not-a-shell)", "/opt/etc/init.d/"} {
		if strings.Contains(string(encoded), private) {
			t.Fatalf("report exposed custom argv %q: %s", private, encoded)
		}
	}
}

func TestSourceReportOmitsUnsafeOrNonCanonicalServiceScript(t *testing.T) {
	for _, replacement := range []string{
		`restart = ["/usr/local/bin/panelctl", "restart"]`,
		`restart = ["/opt/etc/init.d/S99telemt-panel", "restart", "extra"]`,
		`restart = ["/opt/etc/init.d/.hidden", "restart"]`,
	} {
		raw := strings.Replace(sourceFixture(t, false)+customCommandsTOML, `restart = ["/opt/etc/init.d/S99telemt-panel", "restart"]`, replacement, 1)
		source, err := DecodeSource([]byte(raw), "custom.toml", "auto")
		if err != nil {
			t.Fatal(err)
		}
		if source.Report().PanelServiceScript != "" {
			t.Fatalf("unsafe script was derived: %q", source.Report().PanelServiceScript)
		}
	}
}
