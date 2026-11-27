package host

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestServiceStartStopCommands(t *testing.T) {
	for _, tc := range []struct {
		kind        string
		start, stop []string
	}{
		{KindSystemd, []string{"systemctl", "start", "telemt"}, []string{"systemctl", "stop", "telemt"}},
		{KindOpenRC, []string{"rc-service", "telemt", "start"}, []string{"rc-service", "telemt", "stop"}},
		{KindProcd, []string{"/etc/init.d/telemt", "start"}, []string{"/etc/init.d/telemt", "stop"}},
		{KindSysvinit, []string{"/etc/init.d/telemt", "start"}, []string{"/etc/init.d/telemt", "stop"}},
		{KindDocker, []string{"docker", "start", "telemt"}, []string{"docker", "stop", "telemt"}},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			var calls [][]string
			run := func(_ context.Context, name string, args ...string) ([]byte, []byte, error) {
				calls = append(calls, append([]string{name}, args...))
				return nil, nil, nil
			}
			manager := NewServiceManager(tc.kind, Probe{}, run)
			control, ok := manager.(interface {
				Start(context.Context, string) error
				Stop(context.Context, string) error
			})
			if !ok {
				t.Fatalf("%s does not expose start/stop", tc.kind)
			}
			if err := control.Start(context.Background(), "telemt"); err != nil {
				t.Fatal(err)
			}
			if err := control.Stop(context.Background(), "telemt"); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(calls, [][]string{tc.start, tc.stop}) {
				t.Fatalf("commands = %#v", calls)
			}
		})
	}
}

func TestPausedDockerIsNotStopped(t *testing.T) {
	manager := NewDocker(func(context.Context, string, ...string) ([]byte, []byte, error) { return []byte("paused\n"), nil, nil })
	state, err := manager.Status(context.Background(), "telemt")
	if err != nil || state != StatusUnknown {
		t.Fatalf("paused = %s, %v", state, err)
	}
}

func TestServiceControlPropagatesErrors(t *testing.T) {
	failure := errors.New("control denied")
	manager := NewSystemd(func(context.Context, string, ...string) ([]byte, []byte, error) {
		return nil, []byte("access denied"), failure
	})
	control, ok := any(manager).(interface {
		Stop(context.Context, string) error
	})
	if !ok {
		t.Fatal("stop unsupported")
	}
	if err := control.Stop(context.Background(), "telemt"); !errors.Is(err, failure) {
		t.Fatalf("lost command error: %v", err)
	}
}

func TestControlRunnersUseNarrowAllowlistAndPolicyOnlyProbe(t *testing.T) {
	for _, mode := range []string{"direct", "sudo", "command"} {
		t.Run(mode, func(t *testing.T) {
			var calls [][]string
			base := func(_ context.Context, command string, args ...string) ([]byte, []byte, error) {
				calls = append(calls, append([]string{command}, args...))
				return nil, nil, nil
			}
			run := CmdRunner(base)
			if mode != "direct" {
				run = NewSudoCmdRunner(base)
			}
			mgr := NewSystemd(run)
			allow := AllowLists{Services: []string{"telemt", "telemt-panel"}, ControlServices: []string{"telemt"}}
			var runner Runner = NewDirectRunner(allow, mgr, nil)
			if mode == "sudo" {
				runner = NewSudoRunner(allow, mgr, nil, run)
			}
			if mode == "command" {
				runner = NewCommandSudoRunner(allow, mgr, nil, run, nil)
			}
			for _, kind := range []string{OpStartService, OpStopService} {
				if _, err := runner.Run(context.Background(), Op{Kind: kind, Args: map[string]string{ArgService: "telemt"}}); err != nil {
					t.Fatal(err)
				}
				for _, name := range []string{"telemt-panel", "nginx", "../telemt", "-other", "telemt;id"} {
					if _, err := runner.Run(context.Background(), Op{Kind: kind, Args: map[string]string{ArgService: name}}); err == nil {
						t.Fatal("accepted forbidden control target", name)
					}
				}
			}
			want := [][]string{{"systemctl", "start", "telemt"}, {"systemctl", "stop", "telemt"}}
			if mode != "direct" {
				want = [][]string{{"sudo", "-n", "--", "systemctl", "start", "telemt"}, {"sudo", "-n", "--", "systemctl", "stop", "telemt"}}
			}
			if !reflect.DeepEqual(calls, want) {
				t.Fatalf("commands = %#v", calls)
			}
		})
	}
	var calls [][]string
	check := NewSudoPolicyCmdRunner(func(_ context.Context, command string, args ...string) ([]byte, []byte, error) {
		calls = append(calls, append([]string{command}, args...))
		if args[len(args)-2] == "stop" {
			return nil, nil, errors.New("not allowed")
		}
		return nil, nil, nil
	})
	policy := NewSudoRunner(AllowLists{ControlServices: []string{"telemt"}}, NewSystemd(check), nil, check)
	start, stop := ProbeServiceControls(context.Background(), policy, "telemt")
	if !start || stop {
		t.Fatal("new permissions are not independent")
	}
	if !reflect.DeepEqual(calls, [][]string{{"sudo", "-n", "-l", "--", "systemctl", "start", "telemt"}, {"sudo", "-n", "-l", "--", "systemctl", "stop", "telemt"}}) {
		t.Fatalf("unsafe permission probe: %#v", calls)
	}
}
