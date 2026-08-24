package main

import (
	"bytes"
	"context"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/httpapi"
	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
	"golang.org/x/term"
)

// version is injected at build time via -ldflags.
var version = "0.0.0-dev"

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "version":
			fmt.Println("telemt-panel " + version)
			return
		case "hash-password":
			if err := runHashPassword(); err != nil {
				slog.Error("hash-password", "err", err)
				os.Exit(1)
			}
			return
		}
	}

	configPath := flag.String("config", "config.toml", "path to config file")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		slog.Error("load config", "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := newStore(cfg)
	if err != nil {
		slog.Error("open store", "err", err)
		os.Exit(1)
	}
	defer st.Close()

	tc := telemt.New(cfg.Telemt.URL, cfg.Telemt.AuthHeader)
	hb := hub.New(hub.Config{}, tc)
	srv := httpapi.New(cfg, tc, st, hb, version)
	if err := srv.Run(ctx); err != nil {
		slog.Error("server", "err", err)
		os.Exit(1)
	}
}

// newStore builds the state backend selected by cfg.Store.Driver. Only
// "memory" is implemented so far; config.Load already accepts "sqlite" (a
// later milestone), so main must refuse it explicitly here rather than
// silently falling back to an in-memory store an operator didn't ask for.
func newStore(cfg *config.Config) (store.Store, error) {
	switch cfg.Store.Driver {
	case "sqlite":
		return nil, fmt.Errorf("store.driver \"sqlite\" is not implemented yet; use \"memory\"")
	default:
		// Memory driver with no mirror file for now; a data-dir config key
		// to pick the mirror path lands in a later milestone.
		return store.NewMemory("")
	}
}

// runHashPassword implements the `panel hash-password` CLI subcommand:
// reads a password from stdin (a terminal prompt when stdin is a TTY, a
// piped line otherwise) and prints its bcrypt hash for auth.password_hash.
func runHashPassword() error {
	password, err := readPassword()
	if err != nil {
		return fmt.Errorf("read password: %w", err)
	}

	hash, err := auth.HashPassword(password)
	if err != nil {
		return fmt.Errorf("hash password: %w", err)
	}
	fmt.Println(hash)
	return nil
}

func readPassword() (string, error) {
	fd := int(os.Stdin.Fd())
	if term.IsTerminal(fd) {
		fmt.Fprint(os.Stderr, "Password: ")
		raw, err := term.ReadPassword(fd)
		fmt.Fprintln(os.Stderr)
		if err != nil {
			return "", err
		}
		return string(raw), nil
	}

	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		return "", err
	}
	return string(bytes.TrimRight(data, "\r\n")), nil
}
