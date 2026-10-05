package config

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/amirotin/telemt_panel/internal/host"
)

func TestPrivilegedPolicyPathDefaultsAndValidation(t *testing.T) {
	for _, test := range []struct {
		name, binary, policy, want string
		fail                       bool
	}{
		{"native", "/usr/local/bin/telemt-panel", "", host.DefaultPrivilegedPolicyPath, false},
		{"entware", "/opt/bin/telemt-panel", "", host.EntwarePrivilegedPolicyPath, false},
		{"custom", "/usr/local/bin/telemt-panel", "/etc/custom-policy/policy.json", "/etc/custom-policy/policy.json", false},
		{"relative", "/usr/local/bin/telemt-panel", "relative", "", true},
		{"traversal", "/usr/local/bin/telemt-panel", "/etc/custom/../policy.json", "", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.toml")
			raw := "[telemt]\nurl=\"http://127.0.0.1:1\"\n[auth]\ndisabled=true\n[updates]\npanel_binary_path=" + strconv.Quote(test.binary) + "\n[privileges]\npolicy_path=" + strconv.Quote(test.policy) + "\n"
			if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
				t.Fatal(err)
			}
			cfg, err := Load(path)
			if test.fail {
				if err == nil {
					t.Fatal("invalid policy path accepted")
				}
				return
			}
			if err != nil || cfg.Privileges.PolicyPath != test.want {
				t.Fatalf("config=%+v error=%v, want policy %s", cfg, err, test.want)
			}
		})
	}
}
