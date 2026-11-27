package host

import (
	"context"
	"fmt"
	"strings"
)

// ValidServiceTarget checks an argument used as an init-script leaf or CLI target.
func ValidServiceTarget(name string) bool {
	return name != "" && name != "." && name != ".." && !strings.HasPrefix(name, "-") &&
		!strings.ContainsAny(name, "/\x00\r\n")
}

// ServiceController extends managers that support explicit start and stop.
// Restart-only implementations retain the existing ServiceManager contract.
type ServiceController interface {
	ServiceManager
	Start(context.Context, string) error
	Stop(context.Context, string) error
}

func serviceCommand(ctx context.Context, run CmdRunner, command string, args ...string) error {
	_, stderr, err := run(ctx, command, args...)
	if err != nil {
		return fmt.Errorf("%s %s: %s: %w", command, strings.Join(args, " "), strings.TrimSpace(string(stderr)), err)
	}
	return nil
}

func execServiceControl(ctx context.Context, op Op, allow AllowLists, manager ServiceManager) (Output, error) {
	service, err := requireAllowedService(op, allow.ControlServices)
	if err != nil {
		return Output{}, err
	}
	controller, ok := manager.(ServiceController)
	if !ok {
		return Output{}, fmt.Errorf("host: service start/stop is unavailable")
	}
	if op.Kind == OpStartService {
		return Output{}, controller.Start(ctx, service)
	}
	return Output{}, controller.Stop(ctx, service)
}

// ProbeServiceControls checks the additional rights independently. Missing
// start/stop permission must not disable an existing restart/update policy.
// The caller supplies a policy-only Runner, never an executing sudo Runner.
func ProbeServiceControls(ctx context.Context, policy Runner, service string) (start, stop bool) {
	if policy == nil {
		return false, false
	}
	_, startErr := policy.Run(ctx, Op{Kind: OpStartService, Args: map[string]string{ArgService: service}})
	_, stopErr := policy.Run(ctx, Op{Kind: OpStopService, Args: map[string]string{ArgService: service}})
	return startErr == nil, stopErr == nil
}
