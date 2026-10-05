package host

import (
	"os"
	"path/filepath"
	"testing"
)

func TestHelperPathsUsesIndependentStableExecutable(t *testing.T) {
	allow := AllowLists{TargetBinaries: map[string]string{"panel": "/usr/local/bin/telemt-panel", "telemt": "/bin/telemt"}, HelperPath: "/usr/local/libexec/telemt-panel-privileged", PolicyPath: DefaultPrivilegedPolicyPath}
	helper, policy, err := helperPaths(allow)
	if err != nil || helper != allow.HelperPath || policy != allow.PolicyPath {
		t.Fatalf("stable helper rejected: helper=%s policy=%s error=%v", helper, policy, err)
	}
}

func TestStableHelperPolicyRejectsUnsafeExecutableAndAliases(t *testing.T) {
	for _, caseName := range []string{"missing", "symlink", "parent symlink", "writable", "not executable", "live path", "backup path", "lock path", "live inode", "backup inode", "lock inode", "version 1"} {
		t.Run(caseName, func(t *testing.T) {
			fixture := newPrivilegedFixture(t)
			helper := fixture.policy.HelperPath
			switch caseName {
			case "missing":
				if err := os.Remove(helper); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Remove(helper); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(fixture.policy.Binaries["panel"], helper); err != nil {
					t.Fatal(err)
				}
			case "parent symlink":
				parent := filepath.Dir(helper)
				if err := os.Rename(parent, parent+".moved"); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(parent+".moved", parent); err != nil {
					t.Fatal(err)
				}
			case "writable":
				if err := os.Chmod(helper, 0o775); err != nil {
					t.Fatal(err)
				}
			case "not executable":
				if err := os.Chmod(helper, 0o600); err != nil {
					t.Fatal(err)
				}
			case "live path":
				fixture.policy.HelperPath = fixture.policy.Binaries["panel"]
			case "backup path":
				backup := fixture.policy.Binaries["panel"] + ".bak"
				if err := os.WriteFile(backup, []byte("backup"), 0o755); err != nil {
					t.Fatal(err)
				}
				fixture.policy.HelperPath = backup
			case "lock path":
				lock := filepath.Join(filepath.Dir(fixture.policy.Binaries["panel"]), ".telemt-panel-panel.lock")
				if err := os.WriteFile(lock, []byte("lock"), 0o755); err != nil {
					t.Fatal(err)
				}
				fixture.policy.HelperPath = lock
			case "live inode", "backup inode", "lock inode":
				if err := os.Remove(helper); err != nil {
					t.Fatal(err)
				}
				entry := fixture.policy.Binaries["panel"]
				if caseName == "backup inode" {
					entry += ".bak"
					if err := os.WriteFile(entry, []byte("backup"), 0o755); err != nil {
						t.Fatal(err)
					}
				}
				if caseName == "lock inode" {
					entry = filepath.Join(filepath.Dir(entry), ".telemt-panel-panel.lock")
					if err := os.WriteFile(entry, []byte("lock"), 0o755); err != nil {
						t.Fatal(err)
					}
				}
				if err := os.Link(entry, helper); err != nil {
					t.Fatal(err)
				}
			case "version 1":
				fixture.policy.Version = 1
			}
			fixture.writePolicy(t)
			if _, err := loadPrivilegedPolicy(fixture.policyPath, fixture.owner); err == nil {
				t.Fatal("unsafe stable helper policy accepted")
			}
		})
	}
}
