package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/amirotin/telemt_panel/internal/host"
)

func runPrivilegedCommand(args []string, output io.Writer) error {
	usage := errors.New("usage: telemt-panel privileged --policy ROOT_POLICY inspect | privileged --policy ROOT_POLICY install|backup|restore panel|telemt")
	flags := flag.NewFlagSet("privileged", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	path := flags.String("policy", "", "protected root installation policy")
	if err := flags.Parse(args); err != nil || *path == "" || flags.NArg() < 1 {
		return usage
	}
	operation := flags.Arg(0)
	if operation == "inspect" {
		if flags.NArg() != 1 {
			return usage
		}
		policy, err := host.LoadPrivilegedPolicy(*path)
		if err != nil {
			return err
		}
		return json.NewEncoder(output).Encode(policy)
	}
	if flags.NArg() != 2 || (operation != "install" && operation != "backup" && operation != "restore") || (flags.Arg(1) != "panel" && flags.Arg(1) != "telemt") {
		return usage
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	return host.RunPrivilegedInstall(ctx, *path, operation, flags.Arg(1))
}
