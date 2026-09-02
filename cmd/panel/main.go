package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/httpapi"
	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
	"github.com/amirotin/telemt_panel/internal/update"
	"golang.org/x/term"
)

// version is injected at build time via -ldflags.
var version = "0.0.0-dev"

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "version", "--version":
			fmt.Printf("telemt-panel %s (%s: %s)\n", version, store.Variant, strings.Join(store.AvailableDrivers(), " "))
			return
		case "hash-password":
			if err := runHashPassword(); err != nil {
				slog.Error("hash-password", "err", err)
				os.Exit(1)
			}
			return
		case "store":
			if err := runStoreCommand(os.Args[2:]); err != nil {
				slog.Error("store", "err", err)
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

	// Reconcile any update run left dangling by a previous process
	// instance, for both targets: completes a pending panel self-update
	// journal handoff (spec 03-update-engine.md §Журнал) if that's why
	// this process just started, and fails-closed any other non-terminal
	// journal entry (e.g. a telemt update whose panel process died
	// mid-install). A no-op the rest of the time (every target's last
	// journal entry, if any, already terminal).
	if err := update.ReconcileStartup(st, version); err != nil {
		slog.Error("reconcile update startup", "err", err)
	}

	tc := telemt.New(cfg.Telemt.URL, cfg.Telemt.AuthHeader)
	hb := hub.New(hub.Config{}, tc, st)
	hb.StartPersistentCollectors()
	srv := httpapi.New(cfg, tc, st, hb, version)
	if err := srv.Run(ctx); err != nil {
		slog.Error("server", "err", err)
		os.Exit(1)
	}
}

func runStoreCommand(args []string) error {
	if len(args) == 0 {
		return storeCommandUsage()
	}
	switch args[0] {
	case "check":
		return runStoreCheck(args[1:])
	case "export":
		return runStoreExport(args[1:])
	case "import":
		return runStoreImport(args[1:])
	default:
		return storeCommandUsage()
	}
}

func storeCommandUsage() error {
	return errors.New("usage: telemt-panel store check --driver postgres|mysql --dsn DSN | store export --config config.toml --out dump.json | store import --config config.toml --in dump.json")
}

func runStoreCheck(args []string) error {
	flags := flag.NewFlagSet("store check", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	driver := flags.String("driver", "", "database driver")
	dsn := flags.String("dsn", "", "database DSN")
	if err := flags.Parse(args); err != nil {
		return errors.New("usage: telemt-panel store check --driver postgres|mysql --dsn DSN")
	}
	if flags.NArg() != 0 || (*driver != "postgres" && *driver != "mysql") || *dsn == "" {
		return errors.New("usage: telemt-panel store check --driver postgres|mysql --dsn DSN")
	}
	if err := store.CheckConnection(*driver, *dsn); err != nil {
		return err
	}
	fmt.Printf("%s connection ok\n", *driver)
	return nil
}

func runStoreExport(args []string) error {
	flags := flag.NewFlagSet("store export", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	configPath := flags.String("config", "config.toml", "panel config path")
	outPath := flags.String("out", "", "export file")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || *outPath == "" {
		return errors.New("usage: telemt-panel store export --config config.toml --out dump.json")
	}
	st, err := openTransferStore(*configPath, false)
	if err != nil {
		return err
	}
	defer st.Close()
	portable, ok := st.(store.PortableStore)
	if !ok {
		return fmt.Errorf("store driver %q does not support export", st.Driver())
	}
	data, err := portable.ExportData()
	if err != nil {
		return err
	}
	raw, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return fmt.Errorf("encode store export: %w", err)
	}
	raw = append(raw, '\n')
	if err := writeExclusiveFile(*outPath, raw); err != nil {
		return fmt.Errorf("write store export: %w", err)
	}
	fmt.Printf("%s store exported to %s\n", st.Driver(), *outPath)
	return nil
}

func runStoreImport(args []string) error {
	flags := flag.NewFlagSet("store import", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	configPath := flags.String("config", "config.toml", "panel config path")
	inPath := flags.String("in", "", "export file")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || *inPath == "" {
		return errors.New("usage: telemt-panel store import --config config.toml --in dump.json")
	}
	file, err := os.Open(*inPath)
	if err != nil {
		return fmt.Errorf("open store export: %w", err)
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	var data store.PortableData
	if err := decoder.Decode(&data); err != nil {
		return fmt.Errorf("decode store export: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("decode store export: trailing JSON value")
		}
		return fmt.Errorf("decode store export: %w", err)
	}

	st, err := openTransferStore(*configPath, true)
	if err != nil {
		return err
	}
	defer st.Close()
	portable, ok := st.(store.PortableStore)
	if !ok {
		return fmt.Errorf("store driver %q does not support import", st.Driver())
	}
	if err := portable.ImportData(data); err != nil {
		return err
	}
	fmt.Printf("%s store imported from %s\n", st.Driver(), *inPath)
	return nil
}

func openTransferStore(configPath string, importing bool) (store.Store, error) {
	cfg, err := config.Load(configPath)
	if err != nil {
		return nil, fmt.Errorf("load config: %w", err)
	}
	mirrorPath := ""
	if cfg.Store.Driver == "memory" && importing && cfg.DataDir == "" {
		return nil, errors.New("import into the memory store requires data_dir so state can be persisted")
	}
	if cfg.Store.Driver == "memory" && cfg.DataDir != "" {
		if importing {
			if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
				return nil, fmt.Errorf("create data directory: %w", err)
			}
		}
		mirrorPath = filepath.Join(cfg.DataDir, mirrorStateFile)
	}
	st, err := store.Open(store.OpenOptions{
		Driver:     cfg.Store.Driver,
		Path:       cfg.Store.Path,
		DSN:        cfg.Store.DSN,
		MirrorPath: mirrorPath,
	})
	if err != nil {
		return nil, fmt.Errorf("open configured %s store: %w", cfg.Store.Driver, err)
	}
	return st, nil
}

func writeExclusiveFile(path string, data []byte) (err error) {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	keep := false
	defer func() {
		_ = file.Close()
		if !keep {
			_ = os.Remove(path)
		}
	}()
	if _, err = file.Write(data); err != nil {
		return err
	}
	if err = file.Sync(); err != nil {
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	keep = true
	return nil
}

// mirrorStateFile is the mirror's filename within cfg.DataDir.
const mirrorStateFile = "panel-state.json"

// newStore builds the state backend selected by cfg.Store.Driver.
func newStore(cfg *config.Config) (store.Store, error) {
	mirrorPath := resolveMirrorPath(cfg.DataDir)
	if cfg.Store.Driver != "memory" {
		mirrorPath = existingMirrorPath(cfg.DataDir)
	}
	opened, err := store.Open(store.OpenOptions{
		Driver:     cfg.Store.Driver,
		Path:       cfg.Store.Path,
		DSN:        cfg.Store.DSN,
		MirrorPath: mirrorPath,
	})
	if err == nil {
		return opened, nil
	}
	if (cfg.Store.Driver != "postgres" && cfg.Store.Driver != "mysql") || !store.IsConnectionUnavailable(err) {
		return nil, err
	}

	// A remote database outage must not take the administration plane down.
	// The fallback is intentionally process-local: it is never mirrored or
	// written back to the remote database, so recovery requires a restart and
	// cannot create split-brain history.
	temporary, memoryErr := store.Open(store.OpenOptions{Driver: "memory"})
	if memoryErr != nil {
		return nil, fmt.Errorf("open temporary memory store: %w", memoryErr)
	}
	reason := cfg.Store.Driver + " database is unavailable; using temporary memory storage until restart"
	slog.Warn("configured database unavailable; using temporary memory store", "driver", cfg.Store.Driver)
	return store.WithFallback(temporary, cfg.Store.Driver, reason), nil
}

func existingMirrorPath(dataDir string) string {
	if dataDir == "" {
		return ""
	}
	return filepath.Join(dataDir, mirrorStateFile)
}

// resolveMirrorPath turns a data_dir config value into the store mirror's
// file path, creating the directory if it doesn't exist yet. An empty
// dataDir means the mirror is disabled by config and returns "". A
// directory that can't be created (read-only filesystem, e.g. a router) is
// not fatal — it disables the mirror the same way, after a warning, so the
// store doesn't then also warn on every single write for the rest of the
// process's life. Either way, a "" result also gets the one-time
// self-update caveat warning below — without a mirror, ReconcileStartup
// has nothing to reconcile after a self-update restart (see its doc
// comment).
func resolveMirrorPath(dataDir string) string {
	if dataDir == "" {
		warnMirrorDisabled()
		return ""
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		slog.Warn("state mirror disabled: cannot create data_dir", "path", dataDir, "error", err)
		warnMirrorDisabled()
		return ""
	}
	return filepath.Join(dataDir, mirrorStateFile)
}

// warnMirrorDisabled logs the one-time boot caveat that follows from
// running with no store mirror: a panel self-update can still be applied,
// but ReconcileStartup in the process that comes back after the restart
// will find an empty journal and silently treat it as "nothing to
// reconcile" (see update.ReconcileStartup's doc comment), so the
// confirm/roll-back step of self-update is effectively skipped.
func warnMirrorDisabled() {
	slog.Warn("self-update confirmation will not survive a restart without data_dir")
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
