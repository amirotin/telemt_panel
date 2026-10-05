package update

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/amirotin/telemt_panel/internal/host"
	"github.com/amirotin/telemt_panel/internal/host/hosttest"
)

func TestSudoPanelRollbackUsesStableHelperAfterInvalidOrOlderReplacement(t *testing.T) {
	current := os.Getenv("PANEL_NS_HELPER_BINARY")
	older := os.Getenv("PANEL_NS_OLDER_BINARY")
	if current == "" || older == "" {
		t.Skip("provide current static helper and older fixture for namespace integration")
	}
	if err := exec.Command("unshare", "-Ur", "true").Run(); err != nil {
		t.Skip("user namespace unavailable")
	}
	original, err := os.ReadFile(current)
	if err != nil {
		t.Fatal(err)
	}
	olderBytes, err := os.ReadFile(older)
	if err != nil {
		t.Fatal(err)
	}
	for _, candidate := range []struct {
		name string
		data []byte
	}{{"invalid executable", []byte("invalid executable candidate\n")}, {"older without CLI", olderBytes}} {
		t.Run(candidate.name, func(t *testing.T) {
			root := t.TempDir()
			for _, dir := range []string{"bin", "libexec", "etc/policy", "var/staging"} {
				if err := os.MkdirAll(filepath.Join(root, dir), 0o700); err != nil {
					t.Fatal(err)
				}
			}
			binary := filepath.Join(root, "bin", "telemt-panel")
			helper := filepath.Join(root, "libexec", "stable-helper")
			for _, path := range []string{binary, helper} {
				if err := os.WriteFile(path, original, 0o755); err != nil {
					t.Fatal(err)
				}
			}
			telemt := filepath.Join(root, "bin", "telemt")
			if err := os.WriteFile(telemt, []byte("telemt fixture"), 0o755); err != nil {
				t.Fatal(err)
			}
			policy := host.PrivilegedPolicy{Version: host.PrivilegedPolicyVersion, HelperPath: "/libexec/stable-helper", StagingRoot: "/var/staging", Binaries: map[string]string{"panel": "/bin/telemt-panel", "telemt": "/bin/telemt"}}
			policyBytes, err := json.Marshal(policy)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, "etc/policy/policy.json"), policyBytes, 0o600); err != nil {
				t.Fatal(err)
			}
			fixture := newFakeReleaseServer(t)
			setupHappyRelease(fixture, TargetPanel, buildTarGz(t, "telemt-panel", candidate.data))
			fixture.releases[0].Tag = "v1.1.0"
			target := &fakeTarget{name: TargetPanel, repo: "owner/repo", binaryPath: binary, serviceName: "panel", version: "v1.0.0"}
			forward := &forwardingRunner{}
			engine, state := newTestEngine(t, fixture, forward, map[string]Target{TargetPanel: target}, nil)
			engine.stagingDir = filepath.Join(root, "var/staging")
			restarts := 0
			manager := &hosttest.ServiceManager{RestartFunc: func(string) error {
				restarts++
				if restarts == 1 {
					return errors.New("forced restart failure")
				}
				return nil
			}}
			run := func(ctx context.Context, name string, args ...string) ([]byte, []byte, error) {
				command := append([]string{"-Ur", "chroot", root, name}, args...)
				return host.OSCmdRunner(ctx, "unshare", command...)
			}
			forward.runner = host.NewSudoRunner(host.AllowLists{TargetBinaries: map[string]string{"panel": binary, "telemt": telemt}, BinaryPaths: []string{binary, binary + ".bak", telemt, telemt + ".bak"}, HelperPath: "/libexec/stable-helper", PolicyPath: "/etc/policy/policy.json", StagingPrefix: engine.stagingDir, Services: []string{"panel"}}, manager, nil, run)
			if err := engine.Apply(context.Background(), TargetPanel, "v1.1.0"); err == nil {
				t.Fatal("forced restart failure was lost")
			}
			restored, err := os.ReadFile(binary)
			if err != nil || !bytes.Equal(restored, original) {
				t.Fatalf("panel bytes not restored: error=%v", err)
			}
			helperAfter, err := os.ReadFile(helper)
			if err != nil || !bytes.Equal(helperAfter, original) {
				t.Fatalf("web update changed stable helper: error=%v", err)
			}
			stdout, stderr, err := run(context.Background(), "/bin/telemt-panel", "version")
			if err != nil || !bytes.Contains(stdout, []byte("telemt-panel")) {
				t.Fatalf("restored panel cannot execute: stdout=%s stderr=%s error=%v", stdout, stderr, err)
			}
			entries, err := state.ListUpdateJournal(TargetPanel, 1)
			if err != nil || len(entries) != 1 || entries[0].Phase != PhaseRolledBack || restarts != 2 {
				t.Fatalf("rollback journal=%+v restarts=%d error=%v", entries, restarts, err)
			}
		})
	}
}
