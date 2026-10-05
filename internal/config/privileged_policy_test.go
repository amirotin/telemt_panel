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
			wantHelper := host.DefaultPrivilegedHelperPath
			if test.name == "entware" {
				wantHelper = host.EntwarePrivilegedHelperPath
			}
			if cfg.Privileges.HelperPath != wantHelper {
				t.Fatalf("helper default=%s want=%s", cfg.Privileges.HelperPath, wantHelper)
			}
		})
	}
}

func TestPrivilegedPlacementRejectsRuntimeTreeOverlapAndRoleAliases(t *testing.T) {
	for _, bad := range []string{"helper in data", "helper in config", "policy in data", "policy ancestor of config", "helper equals panel", "helper equals policy"} {
		t.Run(bad, func(t *testing.T) {
			root := t.TempDir()
			configPath := filepath.Join(root, "config", "config.toml")
			if err := os.MkdirAll(filepath.Dir(configPath), 0o700); err != nil {
				t.Fatal(err)
			}
			dataDir := filepath.Join(root, "data")
			helper, policy := host.DefaultPrivilegedHelperPath, host.DefaultPrivilegedPolicyPath
			panel := "/usr/local/bin/telemt-panel"
			switch bad {
			case "helper in data":
				helper = filepath.Join(dataDir, "helper")
			case "helper in config":
				helper = filepath.Join(filepath.Dir(configPath), "helper")
			case "policy in data":
				policy = filepath.Join(dataDir, "policy.json")
			case "policy ancestor of config":
				policy = filepath.Join(root, "policy.json")
			case "helper equals panel":
				helper = panel
			case "helper equals policy":
				helper = policy
			}
			raw := "data_dir=" + strconv.Quote(dataDir) + "\n[telemt]\nurl=\"http://127.0.0.1:1\"\n[auth]\ndisabled=true\n[privileges]\nhelper_path=" + strconv.Quote(helper) + "\npolicy_path=" + strconv.Quote(policy) + "\n"
			if err := os.WriteFile(configPath, []byte(raw), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := Load(configPath); err == nil {
				t.Fatal("unsafe runtime privilege placement accepted")
			}
		})
	}
}

func TestPrivilegedHelperPathValidationAndOverride(t *testing.T) {
	for _, path := range []string{"relative", "/etc/../helper", "/", "/usr/libexec/custom-helper"} {
		t.Run(path, func(t *testing.T) {
			configPath := filepath.Join(t.TempDir(), "config.toml")
			raw := "[telemt]\nurl=\"http://127.0.0.1:1\"\n[auth]\ndisabled=true\n[privileges]\nhelper_path=" + strconv.Quote(path) + "\n"
			if err := os.WriteFile(configPath, []byte(raw), 0o600); err != nil {
				t.Fatal(err)
			}
			cfg, err := Load(configPath)
			if path != "/usr/libexec/custom-helper" {
				if err == nil {
					t.Fatal("unsafe helper path accepted")
				}
				return
			}
			if err != nil || cfg.Privileges.HelperPath != path {
				t.Fatalf("config=%+v error=%v", cfg, err)
			}
		})
	}
}
