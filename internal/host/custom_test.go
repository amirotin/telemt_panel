package host

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestCustomPanelControlsUseIndependentCopiedCommands(t *testing.T) {
	var commands CustomCommands
	if err := json.Unmarshal([]byte(`{"Panel":{"Start":["/opt/etc/init.d/S99telemt-panel","start"],"Stop":["/opt/etc/init.d/S99telemt-panel","stop"]}}`), &commands); err != nil {
		t.Fatal(err)
	}
	var calls []recordedCommand
	manager := NewCustom("telemt", "telemt-panel", commands, commandRecorder(&calls, 0))
	commands.Panel.Start[0] = "/changed/source/start"
	commands.Panel.Stop[0] = "/changed/source/stop"
	runner := NewDirectRunner(AllowLists{ControlServices: []string{"telemt-panel"}}, manager, nil)
	for _, kind := range []string{OpStartService, OpStopService} {
		if _, err := runner.Run(context.Background(), Op{Kind: kind, Args: map[string]string{ArgService: "telemt-panel"}}); err != nil {
			t.Fatalf("panel %s: %v", kind, err)
		}
	}
	want := []recordedCommand{
		{"/opt/etc/init.d/S99telemt-panel", []string{"start"}},
		{"/opt/etc/init.d/S99telemt-panel", []string{"stop"}},
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("panel lifecycle commands=%+v, want %+v", calls, want)
	}
	for _, action := range []string{"start", "stop"} {
		copy := manager.Command("telemt-panel", action)
		copy[0] = "/changed"
		if got := manager.Command("telemt-panel", action); got[0] != "/opt/etc/init.d/S99telemt-panel" {
			t.Fatalf("panel %s command mutated: %v", action, got)
		}
	}
}

func customCommandFixture() CustomCommands {
	return CustomCommands{
		Telemt: TelemtCommands{
			Start:   []string{"/opt/etc/init.d/S99telemt", "start", "literal space", "$(not-a-shell)"},
			Stop:    []string{"/opt/etc/init.d/S99telemt", "stop"},
			Restart: []string{"/opt/etc/init.d/S99telemt", "restart"},
		},
		Panel: PanelCommands{Restart: []string{"/opt/etc/init.d/S99telemt-panel", "restart"}},
	}
}

func TestCustomExecutesConfiguredArgvWithoutInterpretation(t *testing.T) {
	commands := customCommandFixture()
	var gotName string
	var gotArgs []string
	manager := NewCustom("telemt", "telemt-panel", commands, func(_ context.Context, name string, args ...string) ([]byte, []byte, error) {
		gotName = name
		gotArgs = append([]string(nil), args...)
		return nil, nil, nil
	})

	runner := NewDirectRunner(AllowLists{ControlServices: []string{"telemt"}}, manager, nil)
	if _, err := runner.Run(context.Background(), Op{Kind: OpStartService, Args: map[string]string{ArgService: "telemt"}}); err != nil {
		t.Fatal(err)
	}
	if gotName != "/opt/etc/init.d/S99telemt" || !reflect.DeepEqual(gotArgs, []string{"start", "literal space", "$(not-a-shell)"}) {
		t.Fatalf("runner argv = %q %q", gotName, gotArgs)
	}
	if got := manager.Command("telemt", "start"); !reflect.DeepEqual(got, commands.Telemt.Start) {
		t.Fatalf("Command = %#v, want %#v", got, commands.Telemt.Start)
	}
}

func TestCustomCopiesConfiguredCommands(t *testing.T) {
	commands := customCommandFixture()
	manager := NewCustom("telemt", "telemt-panel", commands, func(context.Context, string, ...string) ([]byte, []byte, error) {
		return nil, nil, nil
	})
	commands.Telemt.Restart[0] = "/changed/source"
	got := manager.Command("telemt", "restart")
	got[0] = "/changed/result"

	if again := manager.Command("telemt", "restart"); !reflect.DeepEqual(again, []string{"/opt/etc/init.d/S99telemt", "restart"}) {
		t.Fatalf("stored command was mutated: %#v", again)
	}
}

func TestCustomRoutesOnlyApprovedServiceActions(t *testing.T) {
	commands := customCommandFixture()
	var calls [][]string
	manager := NewCustom("telemt", "telemt-panel", commands, func(_ context.Context, name string, args ...string) ([]byte, []byte, error) {
		calls = append(calls, append([]string{name}, args...))
		return nil, nil, nil
	})

	for _, tc := range []struct {
		name string
		run  func() error
		want []string
	}{
		{name: "telemt stop", run: func() error { return manager.Stop(context.Background(), "telemt") }, want: commands.Telemt.Stop},
		{name: "telemt restart", run: func() error { return manager.Restart(context.Background(), "telemt") }, want: commands.Telemt.Restart},
		{name: "panel restart", run: func() error { return manager.Restart(context.Background(), "telemt-panel") }, want: commands.Panel.Restart},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls = nil
			if err := tc.run(); err != nil {
				t.Fatal(err)
			}
			if len(calls) != 1 || !reflect.DeepEqual(calls[0], tc.want) {
				t.Fatalf("calls = %#v, want %#v", calls, tc.want)
			}
		})
	}

	for _, tc := range []struct {
		name string
		run  func() error
	}{
		{name: "unknown restart", run: func() error { return manager.Restart(context.Background(), "other") }},
		{name: "panel start", run: func() error { return manager.Start(context.Background(), "telemt-panel") }},
		{name: "panel stop", run: func() error { return manager.Stop(context.Background(), "telemt-panel") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls = nil
			if err := tc.run(); err == nil {
				t.Fatal("unsupported target/action accepted")
			}
			if len(calls) != 0 {
				t.Fatalf("unsupported target/action executed: %#v", calls)
			}
		})
	}
	for _, key := range [][2]string{{"other", "restart"}, {"telemt-panel", "start"}, {"telemt", "status"}} {
		if got := manager.Command(key[0], key[1]); got != nil {
			t.Fatalf("Command(%q, %q) = %#v, want nil", key[0], key[1], got)
		}
	}
}

func TestCustomCapabilitiesAndStatus(t *testing.T) {
	manager := NewCustom("telemt", "telemt-panel", customCommandFixture(), nil)
	if manager.Kind() != KindCustom {
		t.Fatalf("Kind = %q", manager.Kind())
	}
	if got := manager.Caps(); got != (ServiceCaps{CanRestart: true, CanStatus: false}) {
		t.Fatalf("Caps = %+v", got)
	}
	if status, err := manager.Status(context.Background(), "telemt"); status != StatusUnknown || err != nil {
		t.Fatalf("Status = %q, %v", status, err)
	}
}

func TestCustomPreservesSudoAndPolicyArgv(t *testing.T) {
	for _, tc := range []struct {
		name string
		wrap func(CmdRunner) CmdRunner
		want []string
	}{
		{name: "sudo", wrap: NewSudoCmdRunner, want: []string{"-n", "--", "/opt/etc/init.d/S99telemt-panel", "restart"}},
		{name: "policy", wrap: NewSudoPolicyCmdRunner, want: []string{"-n", "-l", "--", "/opt/etc/init.d/S99telemt-panel", "restart"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var name string
			var args []string
			base := func(_ context.Context, gotName string, gotArgs ...string) ([]byte, []byte, error) {
				name = gotName
				args = append([]string(nil), gotArgs...)
				return nil, nil, nil
			}
			wrapped := tc.wrap(base)
			manager := NewCustom("telemt", "telemt-panel", customCommandFixture(), wrapped)
			runner := NewSudoRunner(AllowLists{Services: []string{"telemt-panel"}}, manager, nil, wrapped)
			if _, err := runner.Run(context.Background(), Op{Kind: OpRestartService, Args: map[string]string{ArgService: "telemt-panel"}}); err != nil {
				t.Fatal(err)
			}
			if name != "sudo" || !reflect.DeepEqual(args, tc.want) {
				t.Fatalf("runner argv = %q %#v, want sudo %#v", name, args, tc.want)
			}
		})
	}
}

func TestCustomDirectRunnerUsesPanelRestartBinding(t *testing.T) {
	var got []string
	manager := NewCustom("telemt", "telemt-panel", customCommandFixture(), func(_ context.Context, name string, args ...string) ([]byte, []byte, error) {
		got = append([]string{name}, args...)
		return nil, nil, nil
	})
	runner := NewDirectRunner(AllowLists{Services: []string{"telemt-panel"}}, manager, nil)
	if _, err := runner.Run(context.Background(), Op{Kind: OpRestartService, Args: map[string]string{ArgService: "telemt-panel"}}); err != nil {
		t.Fatal(err)
	}
	want := []string{"/opt/etc/init.d/S99telemt-panel", "restart"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("update restart argv = %#v, want %#v", got, want)
	}
}

func TestCustomPropagatesRunnerErrorWithoutLeakingArgv(t *testing.T) {
	secret := "PRIVATE_CUSTOM_ARGUMENT"
	wantErr := errors.New(secret)
	commands := customCommandFixture()
	commands.Panel.Restart = []string{"/opt/etc/init.d/S99telemt-panel", "restart", secret}
	manager := NewCustom("telemt", "telemt-panel", commands, func(_ context.Context, _ string, _ ...string) ([]byte, []byte, error) {
		return nil, []byte(secret), wantErr
	})
	err := manager.Restart(context.Background(), "telemt-panel")
	if !errors.Is(err, wantErr) {
		t.Fatalf("Restart error = %v, want wrapped runner error", err)
	}
	if strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), "/opt/etc") {
		t.Fatalf("Restart error leaked argv: %v", err)
	}
}
