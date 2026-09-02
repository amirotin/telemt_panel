package host

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"testing"
)

type recordedCommand struct {
	name string
	args []string
}

func commandRecorder(calls *[]recordedCommand, failAt int) CmdRunner {
	return func(_ context.Context, name string, args ...string) ([]byte, []byte, error) {
		*calls = append(*calls, recordedCommand{name: name, args: append([]string(nil), args...)})
		if failAt > 0 && len(*calls) == failAt {
			return nil, []byte("denied"), errors.New("exit")
		}
		return nil, nil, nil
	}
}

func TestSudoRunner_SharesBinaryAndServicePathAcrossTargets(t *testing.T) {
	staging := filepath.Join(t.TempDir(), "staging")
	telemt := "/usr/local/bin/telemt"
	panel := "/usr/local/bin/telemt-panel"
	allow := AllowLists{
		BinaryPaths:   []string{telemt, telemt + ".bak", panel, panel + ".bak"},
		StagingPrefix: staging,
		Services:      []string{"telemt", "telemt-panel"},
	}

	var calls []recordedCommand
	sudoRun := NewSudoCmdRunner(commandRecorder(&calls, 0))
	svcMgr := NewServiceManager(KindSystemd, Probe{}, sudoRun)
	runner := NewSudoRunner(allow, svcMgr, nil, sudoRun)

	ops := []Op{
		{Kind: OpInstallBinary, Args: map[string]string{ArgStaging: filepath.Join(staging, "telemt", "bin"), ArgDest: telemt}},
		{Kind: OpRestartService, Args: map[string]string{ArgService: "telemt"}},
		{Kind: OpInstallBinary, Args: map[string]string{ArgStaging: filepath.Join(staging, "panel", "bin"), ArgDest: panel}},
		{Kind: OpRestartService, Args: map[string]string{ArgService: "telemt-panel"}},
	}
	for _, op := range ops {
		if _, err := runner.Run(context.Background(), op); err != nil {
			t.Fatalf("Run(%s): %v", op.Kind, err)
		}
	}

	want := []recordedCommand{
		{"sudo", []string{"-n", "--", "cp", "-f", filepath.Join(staging, "telemt", "bin"), telemt + ".tmp"}},
		{"sudo", []string{"-n", "--", "chmod", "0755", telemt + ".tmp"}},
		{"sudo", []string{"-n", "--", "mv", "-f", telemt + ".tmp", telemt}},
		{"sudo", []string{"-n", "--", "systemctl", "restart", "telemt"}},
		{"sudo", []string{"-n", "--", "cp", "-f", filepath.Join(staging, "panel", "bin"), panel + ".tmp"}},
		{"sudo", []string{"-n", "--", "chmod", "0755", panel + ".tmp"}},
		{"sudo", []string{"-n", "--", "mv", "-f", panel + ".tmp", panel}},
		{"sudo", []string{"-n", "--", "systemctl", "restart", "telemt-panel"}},
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("commands = %#v\nwant %#v", calls, want)
	}
}

func TestSudoRunner_UsesEveryServiceManagerWithoutDuplicatingItsCommands(t *testing.T) {
	cases := []struct {
		kind string
		want []string
	}{
		{KindSystemd, []string{"-n", "--", "systemctl", "restart", "telemt"}},
		{KindOpenRC, []string{"-n", "--", "rc-service", "telemt", "restart"}},
		{KindProcd, []string{"-n", "--", "/etc/init.d/telemt", "restart"}},
		{KindSysvinit, []string{"-n", "--", "/etc/init.d/telemt", "restart"}},
	}
	for _, tc := range cases {
		t.Run(tc.kind, func(t *testing.T) {
			var calls []recordedCommand
			sudoRun := NewSudoCmdRunner(commandRecorder(&calls, 0))
			runner := NewSudoRunner(
				AllowLists{Services: []string{"telemt"}},
				NewServiceManager(tc.kind, Probe{}, sudoRun), nil, sudoRun,
			)
			if _, err := runner.Run(context.Background(), Op{Kind: OpRestartService, Args: map[string]string{ArgService: "telemt"}}); err != nil {
				t.Fatal(err)
			}
			if len(calls) != 1 || calls[0].name != "sudo" || !reflect.DeepEqual(calls[0].args, tc.want) {
				t.Fatalf("calls = %#v, want sudo %#v", calls, tc.want)
			}
		})
	}
}

func TestSudoRunner_RejectsBeforeSpawningCommand(t *testing.T) {
	var calls []recordedCommand
	runner := NewSudoRunner(
		AllowLists{BinaryPaths: []string{"/usr/local/bin/telemt"}, StagingPrefix: "/var/lib/telemt-panel/staging"},
		nil, nil, NewSudoCmdRunner(commandRecorder(&calls, 0)),
	)
	_, err := runner.Run(context.Background(), Op{Kind: OpInstallBinary, Args: map[string]string{
		ArgStaging: "/tmp/untrusted", ArgDest: "/usr/local/bin/telemt",
	}})
	if err == nil {
		t.Fatal("expected staging validation error")
	}
	if len(calls) != 0 {
		t.Fatalf("spawned %d commands after validation failure", len(calls))
	}
}

func TestProbeRunner_ChecksPolicyWithoutExecutingCommands(t *testing.T) {
	staging := "/var/lib/telemt-panel/staging"
	dest := "/usr/local/bin/telemt"
	allow := AllowLists{BinaryPaths: []string{dest}, StagingPrefix: staging, Services: []string{"telemt"}}
	var calls []recordedCommand
	policyRun := NewSudoPolicyCmdRunner(commandRecorder(&calls, 0))
	runner := NewSudoRunner(allow, NewServiceManager(KindOpenRC, Probe{}, policyRun), nil, policyRun)
	ops := []Op{
		{Kind: OpInstallBinary, Args: map[string]string{ArgStaging: filepath.Join(staging, "telemt", "bin"), ArgDest: dest}},
		{Kind: OpRestartService, Args: map[string]string{ArgService: "telemt"}},
	}
	if !ProbeRunner(context.Background(), runner, ops) {
		t.Fatal("policy probe unexpectedly failed")
	}
	for _, call := range calls {
		if call.name != "sudo" || len(call.args) < 4 || call.args[0] != "-n" || call.args[1] != "-l" || call.args[2] != "--" {
			t.Fatalf("probe executed a command instead of checking policy: %#v", call)
		}
	}
}

func TestProbeRunner_FailsClosedWhenAnyRequiredCommandIsDenied(t *testing.T) {
	staging := "/var/lib/telemt-panel/staging"
	dest := "/usr/local/bin/telemt"
	allow := AllowLists{BinaryPaths: []string{dest}, StagingPrefix: staging}
	var calls []recordedCommand
	policyRun := NewSudoPolicyCmdRunner(commandRecorder(&calls, 2))
	runner := NewSudoRunner(allow, nil, nil, policyRun)
	if ProbeRunner(context.Background(), runner, []Op{{Kind: OpInstallBinary, Args: map[string]string{
		ArgStaging: filepath.Join(staging, "telemt", "bin"), ArgDest: dest,
	}}}) {
		t.Fatal("partial sudo policy must not enable updates")
	}
	if len(calls) != 2 {
		t.Fatalf("probe continued after denial: %d calls", len(calls))
	}
}
