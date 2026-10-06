package host

import (
	"context"
	"fmt"
)

// TelemtCommands contains the explicitly approved lifecycle commands for Telemt.
type TelemtCommands struct {
	Start   []string `toml:"start"`
	Stop    []string `toml:"stop"`
	Restart []string `toml:"restart"`
}

// PanelCommands contains the explicitly approved lifecycle commands for the panel.
type PanelCommands struct {
	Start   []string `toml:"start"`
	Stop    []string `toml:"stop"`
	Restart []string `toml:"restart"`
}

// CustomCommands contains fixed argv vectors for custom service management.
type CustomCommands struct {
	Telemt TelemtCommands `toml:"telemt"`
	Panel  PanelCommands  `toml:"panel"`
}

// Custom executes fixed, validated argv vectors without a shell.
type Custom struct {
	telemtName string
	panelName  string
	commands   CustomCommands
	run        CmdRunner
}

// NewCustom builds a custom ServiceManager and defensively copies its argv.
func NewCustom(telemtName, panelName string, commands CustomCommands, runner CmdRunner) *Custom {
	return &Custom{
		telemtName: telemtName,
		panelName:  panelName,
		commands: CustomCommands{
			Telemt: TelemtCommands{
				Start:   cloneArgv(commands.Telemt.Start),
				Stop:    cloneArgv(commands.Telemt.Stop),
				Restart: cloneArgv(commands.Telemt.Restart),
			},
			Panel: PanelCommands{
				Start:   cloneArgv(commands.Panel.Start),
				Stop:    cloneArgv(commands.Panel.Stop),
				Restart: cloneArgv(commands.Panel.Restart),
			},
		},
		run: runner,
	}
}

// Kind implements ServiceManager.
func (c *Custom) Kind() string { return KindCustom }

// Status implements ServiceManager. Custom commands have no status binding.
func (c *Custom) Status(context.Context, string) (ServiceStatus, error) {
	return StatusUnknown, nil
}

// Start starts a configured service using its approved argv.
func (c *Custom) Start(ctx context.Context, service string) error {
	return c.execute(ctx, service, "start")
}

// Stop stops a configured service using its approved argv.
func (c *Custom) Stop(ctx context.Context, service string) error {
	return c.execute(ctx, service, "stop")
}

// Restart restarts Telemt or the panel using its configured argv.
func (c *Custom) Restart(ctx context.Context, service string) error {
	return c.execute(ctx, service, "restart")
}

// Caps implements ServiceManager.
func (c *Custom) Caps() ServiceCaps {
	return ServiceCaps{CanRestart: true, CanStatus: false}
}

// Command returns a defensive copy of the configured argv for a service action.
func (c *Custom) Command(service, action string) []string {
	if service == c.telemtName {
		switch action {
		case "start":
			return cloneArgv(c.commands.Telemt.Start)
		case "stop":
			return cloneArgv(c.commands.Telemt.Stop)
		case "restart":
			return cloneArgv(c.commands.Telemt.Restart)
		}
	}
	if service == c.panelName {
		switch action {
		case "start":
			return cloneArgv(c.commands.Panel.Start)
		case "stop":
			return cloneArgv(c.commands.Panel.Stop)
		case "restart":
			return cloneArgv(c.commands.Panel.Restart)
		}
	}
	return nil
}

func (c *Custom) execute(ctx context.Context, service, action string) error {
	command := c.Command(service, action)
	if len(command) == 0 {
		return fmt.Errorf("host: custom command is not configured for service action")
	}
	if c.run == nil {
		return fmt.Errorf("host: custom command runner is not configured")
	}
	_, _, err := c.run(ctx, command[0], command[1:]...)
	if err != nil {
		return &customCommandRunError{cause: err}
	}
	return nil
}

type customCommandRunError struct {
	cause error
}

func (e *customCommandRunError) Error() string { return "host: custom service command failed" }

func (e *customCommandRunError) Unwrap() error { return e.cause }

func cloneArgv(argv []string) []string {
	if len(argv) == 0 {
		return nil
	}
	return append([]string(nil), argv...)
}
