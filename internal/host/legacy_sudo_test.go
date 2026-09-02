package host

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestLegacySudoRunner_AdaptsCurrentEngineOpsToV0Policy(t *testing.T) {
	staging := filepath.Join(t.TempDir(), "staging")
	runDir := filepath.Join(staging, "runs", "telemt")
	if err := os.MkdirAll(runDir, 0o700); err != nil {
		t.Fatal(err)
	}
	live := filepath.Join(t.TempDir(), "bin", "telemt")
	backup := live + ".bak"
	allow := AllowLists{
		BinaryPaths:   []string{live, backup},
		StagingPrefix: staging,
		Services:      []string{"telemt"},
	}
	stagedBackup := filepath.Join(runDir, "backup")
	stagedBinary := filepath.Join(runDir, "bin")
	legacyBackup := filepath.Join(staging, "telemt.bak")
	if err := os.WriteFile(stagedBackup, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stagedBinary, []byte("new"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(legacyBackup, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}

	var calls []recordedCommand
	sudoRun := NewSudoCmdRunner(commandRecorder(&calls, 0))
	runner := NewLegacySudoRunner(allow, NewServiceManager(KindSystemd, Probe{}, sudoRun), nil, sudoRun)
	ops := []Op{
		{Kind: OpInstallBinary, Args: map[string]string{ArgStaging: stagedBackup, ArgDest: backup}},
		{Kind: OpInstallBinary, Args: map[string]string{ArgStaging: stagedBinary, ArgDest: live}},
		{Kind: OpRestoreBinary, Args: map[string]string{ArgBackup: backup, ArgDest: live}},
		{Kind: OpRestartService, Args: map[string]string{ArgService: "telemt"}},
	}
	for _, op := range ops {
		if _, err := runner.Run(context.Background(), op); err != nil {
			t.Fatalf("Run(%s): %v", op.Kind, err)
		}
	}

	legacySource := filepath.Join(staging, "telemt")
	tmp := filepath.Join(filepath.Dir(live), ".telemt.tmp")
	want := []recordedCommand{
		{"sudo", []string{"-n", "--", "cp", "-f", live, legacyBackup}},
		{"sudo", []string{"-n", "--", "cp", "-f", legacySource, tmp}},
		{"sudo", []string{"-n", "--", "chmod", "0755", tmp}},
		{"sudo", []string{"-n", "--", "mv", "-f", tmp, live}},
		{"sudo", []string{"-n", "--", "rm", "-f", tmp}},
		{"sudo", []string{"-n", "--", "cp", "-f", legacySource, tmp}},
		{"sudo", []string{"-n", "--", "chmod", "0755", tmp}},
		{"sudo", []string{"-n", "--", "mv", "-f", tmp, live}},
		{"sudo", []string{"-n", "--", "rm", "-f", tmp}},
		{"sudo", []string{"-n", "--", "systemctl", "restart", "telemt"}},
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("commands = %#v\nwant %#v", calls, want)
	}
	if _, err := os.Stat(legacySource); !os.IsNotExist(err) {
		t.Fatalf("legacy staging source was not cleaned up: %v", err)
	}
}

func TestLegacySudoPolicyRunner_IsReadOnly(t *testing.T) {
	staging := filepath.Join(t.TempDir(), "missing-staging")
	live := "/usr/local/bin/telemt-panel"
	allow := AllowLists{
		BinaryPaths:   []string{live, live + ".bak"},
		StagingPrefix: staging,
		Services:      []string{"telemt-panel"},
	}
	var calls []recordedCommand
	policyRun := NewSudoPolicyCmdRunner(commandRecorder(&calls, 0))
	runner := NewLegacySudoPolicyRunner(allow, NewServiceManager(KindSystemd, Probe{}, policyRun), nil, policyRun)
	ops := []Op{
		{Kind: OpInstallBinary, Args: map[string]string{ArgStaging: filepath.Join(staging, "runs", "panel", "backup"), ArgDest: live + ".bak"}},
		{Kind: OpInstallBinary, Args: map[string]string{ArgStaging: filepath.Join(staging, "runs", "panel", "bin"), ArgDest: live}},
		{Kind: OpRestoreBinary, Args: map[string]string{ArgBackup: live + ".bak", ArgDest: live}},
		{Kind: OpRestartService, Args: map[string]string{ArgService: "telemt-panel"}},
	}
	if !ProbeRunner(context.Background(), runner, ops) {
		t.Fatal("legacy policy probe failed")
	}
	if _, err := os.Stat(staging); !os.IsNotExist(err) {
		t.Fatalf("policy probe mutated staging: %v", err)
	}
	for _, call := range calls {
		if call.name != "sudo" || len(call.args) < 4 || call.args[1] != "-l" {
			t.Fatalf("policy probe executed instead of listing: %#v", call)
		}
	}
}
