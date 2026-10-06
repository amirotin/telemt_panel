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

	"github.com/amirotin/telemt_panel/internal/atomicfile"
	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/host"
	"github.com/amirotin/telemt_panel/internal/httpapi"
	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/migration"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
	"github.com/amirotin/telemt_panel/internal/update"
	"golang.org/x/term"
)

// version is injected at build time via -ldflags.
var version = "0.0.0-dev"

func main() {
	os.Exit(run())
}

func run() int {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "version", "--version":
			fmt.Printf("telemt-panel %s (%s: %s)\n", version, store.Variant, strings.Join(store.AvailableDrivers(), " "))
			return 0
		case "hash-password":
			if err := runHashPassword(); err != nil {
				slog.Error("hash-password", "err", err)
				return 1
			}
			return 0
		case "tls":
			if err := runTLSCommand(os.Args[2:]); err != nil {
				slog.Error("TLS check", "err", err)
				return 1
			}
			return 0
		case "config":
			if err := runConfigCommand(os.Args[2:], os.Stdout); err != nil {
				slog.Error("config", "err", err)
				return 1
			}
			return 0
		case "store":
			if err := runStoreCommand(os.Args[2:]); err != nil {
				slog.Error("store", "err", err)
				return 1
			}
			return 0
		case "service":
			if err := runServiceCommand(os.Args[2:], host.OSCmdRunner); err != nil {
				slog.Error("service", "err", err)
				return 1
			}
			return 0
		case "privileged":
			if err := runPrivilegedCommand(os.Args[2:], os.Stdout); err != nil {
				slog.Error("privileged", "err", err)
				if atomicfile.Published(err) {
					return 2
				}
				return 1
			}
			return 0
		case "update-worker":
			if err := runUpdateWorkerCommand(os.Args[2:], os.Stdout); err != nil {
				slog.Error("update worker", "err", err)
				return 1
			}
			return 0
		}
	}

	flags := flag.NewFlagSet("telemt-panel", flag.ContinueOnError)
	configPath := flags.String("config", "config.toml", "path to config file")
	if err := flags.Parse(os.Args[1:]); err != nil || flags.NArg() != 0 {
		return 1
	}

	source, err := loadStartupSource(*configPath)
	if err != nil {
		slog.Error("load config", "err", err)
		return 1
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	return runRuntime(ctx, source, *configPath)
}

func runRuntime(ctx context.Context, source *config.Source, configPath string) (code int) {
	if source.Config.DataDir != "" {
		lock, err := store.AcquireDataDirLock(source.Config.DataDir)
		if err != nil {
			slog.Error("runtime ownership", "err", err)
			return 1
		}
		defer func() {
			if err := lock.Close(); err != nil {
				slog.Error("release runtime ownership", "err", err)
				code = 1
			}
		}()
	}
	st, err := newSourceStore(source)
	if err != nil {
		slog.Error("open store", "err", err)
		return 1
	}
	return runRuntimeStore(ctx, source.Config, configPath, st)
}

func runRuntimeStore(ctx context.Context, cfg *config.Config, configPath string, st store.Store) (code int) {
	defer func() {
		if err := st.Close(); err != nil {
			slog.Error("close store", "err", err)
			code = 1
		}
	}()

	// Restart confirmation is deferred until every required listener serves.
	pending, err := update.ReconcileInterrupted(st, version)
	if err != nil {
		slog.Error("reconcile update startup", "err", err)
		return 1
	}

	tc := telemt.New(cfg.Telemt.URL, cfg.Telemt.AuthHeader)
	hb := hub.New(hub.Config{}, tc, st)
	defer hb.Close()
	hb.StartPersistentCollectors()
	onReady := func() error {
		if pending != nil {
			return update.ConfirmPanelReady(st, *pending, version)
		}
		return nil
	}
	srv := httpapi.New(cfg, tc, st, hb, version, httpapi.EngineOptions{PanelLifecycleContext: ctx, OnReady: onReady})
	srv.SetTLSConfigPath(configPath)
	if err := srv.Run(ctx); err != nil {
		slog.Error("server", "err", err)
		return 1
	}
	return 0
}

func runStoreCommand(args []string) error {
	if len(args) == 0 {
		return storeCommandUsage()
	}
	switch args[0] {
	case "export":
		return runStoreExport(args[1:])
	case "import":
		return runStoreImport(args[1:])
	default:
		return storeCommandUsage()
	}
}

func storeCommandUsage() error {
	return errors.New("usage: telemt-panel store export --config config.toml --out dump.json | store import --config config.toml --in dump.json")
}

func runStoreExport(args []string) (result error) {
	flags := flag.NewFlagSet("store export", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	configPath := flags.String("config", "config.toml", "panel config path")
	outPath := flags.String("out", "", "export file")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || *outPath == "" {
		return errors.New("usage: telemt-panel store export --config config.toml --out dump.json")
	}
	st, err := openReadOnlyTransferStore(*configPath)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, st.Close()) }()
	if err := writeExclusiveFile(*outPath, st.ExportJSON); err != nil {
		return fmt.Errorf("write store export: %w", err)
	}
	fmt.Printf("%s store exported to %s\n", st.Driver(), *outPath)
	return nil
}

func openReadOnlyTransferStore(configPath string) (store.ReadOnlyTransfer, error) {
	cfg, err := config.Load(configPath)
	if err != nil {
		return nil, fmt.Errorf("load config: %w", err)
	}
	if cfg.DataDir == "" && cfg.Store.Driver == "memory" {
		return nil, errors.New("store transfer requires data_dir so panel state can be persisted")
	}
	statePath := ""
	if cfg.DataDir != "" {
		statePath = filepath.Join(cfg.DataDir, panelStateFile)
	}
	return store.OpenReadOnlyTransfer(statePath, store.OpenOptions{Driver: cfg.Store.Driver, Path: cfg.Store.Path})
}

func runStoreImport(args []string) (result error) {
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
	if err := store.ValidatePortableFormatVersion(data.FormatVersion); err != nil {
		return err
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	if cfg.DataDir == "" {
		return errors.New("store transfer requires data_dir so panel state can be persisted")
	}
	lock, err := store.AcquireDataDirLock(cfg.DataDir)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, lock.Close()) }()
	st, err := openTransferStoreConfig(cfg, true)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, st.Close()) }()
	portable, ok := st.(store.PortableStore)
	if !ok {
		return fmt.Errorf("store driver %q does not support import", st.Driver())
	}
	if st.Driver() == "memory" && !store.PortableHistoryEmpty(data) {
		return errors.New("memory store cannot import history because it would be lost on restart; use a SQLite destination or a state-only backup")
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
	return openTransferStoreConfig(cfg, importing)
}

func openTransferStoreConfig(cfg *config.Config, importing bool) (store.Store, error) {
	if !importing {
		return nil, errors.New("writable transfer opener is import-only; export requires a readonly snapshot")
	}
	if cfg.DataDir == "" && (importing || cfg.Store.Driver == "memory") {
		return nil, errors.New("store transfer requires data_dir so panel state can be persisted")
	}
	statePath := ""
	if cfg.DataDir != "" {
		if importing {
			if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
				return nil, fmt.Errorf("create data directory: %w", err)
			}
		}
		statePath = filepath.Join(cfg.DataDir, panelStateFile)
	}
	state, err := store.NewState(statePath)
	if err != nil {
		return nil, fmt.Errorf("open panel state: %w", err)
	}
	history, err := store.Open(store.OpenOptions{
		Driver: cfg.Store.Driver,
		Path:   cfg.Store.Path,
	})
	if err != nil {
		_ = state.Close()
		return nil, fmt.Errorf("open configured %s store: %w", cfg.Store.Driver, err)
	}
	combined, err := store.NewComposite(state, history)
	if err != nil {
		_ = history.Close()
		_ = state.Close()
		return nil, fmt.Errorf("combine panel state and history: %w", err)
	}
	return combined, nil
}

func writeExclusiveFile(path string, write func(io.Writer) error) (err error) {
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
	if err = write(file); err != nil {
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

// panelStateFile is the control-plane state filename within cfg.DataDir.
const panelStateFile = "panel-state.json"

// newStore keeps mandatory panel state in panel-state.json and uses the
// configured driver only for observability history.
func newStore(cfg *config.Config) (store.Store, error) {
	return newSourceStore(&config.Source{Format: "current", Config: cfg})
}

func newSourceStore(source *config.Source) (store.Store, error) {
	cfg := source.Config
	statePath, err := resolveStatePath(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	state, err := store.NewState(statePath)
	if err != nil {
		return nil, fmt.Errorf("open panel state: %w", err)
	}
	if source.Legacy != nil {
		warnings, err := migration.PrepareLegacyStartup(state, source)
		if err != nil {
			_ = state.Close()
			return nil, err
		}
		slog.Warn("legacy configuration compatibility mode; source file preserved; transport edits require manual configuration")
		for _, warning := range warnings {
			slog.Warn("legacy startup", "code", warning)
		}
	}
	if cfg.Auth.Disabled {
		slog.Warn("panel authentication is DISABLED; anyone reaching the listener has full administrator access; restrict access with a firewall or authenticated reverse proxy")
	} else {
		if err := state.BindPasswordAuth(cfg.Auth.Username, cfg.Auth.PasswordHash); err != nil {
			_ = state.Close()
			return nil, fmt.Errorf("bind password authentication: %w", err)
		}
	}
	history, err := store.Open(store.OpenOptions{
		Driver: cfg.Store.Driver,
		Path:   cfg.Store.Path,
	})
	if store.IsRuntimeOpenError(err) {
		slog.Warn("SQLite history unavailable; using temporary memory history until restart", "err", err)
		history, err = store.NewMemoryHistory()
	}
	if err != nil {
		_ = state.Close()
		return nil, err
	}
	combined, combineErr := store.NewComposite(state, history)
	if combineErr != nil {
		_ = history.Close()
		_ = state.Close()
		return nil, fmt.Errorf("configure history store: %w", combineErr)
	}
	return combined, nil
}

// resolveStatePath creates the directory for the local control-plane state.
// A configured but unwritable data_dir is fatal: silently losing auth or
// update-recovery state would be less safe than refusing to start.
func resolveStatePath(dataDir string) (string, error) {
	if dataDir == "" {
		warnStatePersistenceDisabled()
		return "", nil
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return "", fmt.Errorf("create panel state directory %s: %w", dataDir, err)
	}
	probe, err := os.CreateTemp(dataDir, ".panel-state-probe-*.tmp")
	if err != nil {
		return "", fmt.Errorf("verify panel state directory %s: %w", dataDir, err)
	}
	probePath := probe.Name()
	if err := probe.Close(); err != nil {
		_ = os.Remove(probePath)
		return "", fmt.Errorf("verify panel state directory %s: %w", dataDir, err)
	}
	if err := os.Remove(probePath); err != nil {
		return "", fmt.Errorf("clean panel state directory probe %s: %w", dataDir, err)
	}
	return filepath.Join(dataDir, panelStateFile), nil
}

// warnStatePersistenceDisabled reports that an explicitly omitted data_dir
// makes all control-plane state process-local, including authentication and
// self-update recovery.
func warnStatePersistenceDisabled() {
	slog.Warn("panel state will not survive a restart without data_dir")
}

// runHashPassword implements the `panel hash-password` CLI subcommand:
// reads a password from stdin (a terminal prompt when stdin is a TTY, a
// piped line otherwise) and prints its bcrypt hash for auth.password_hash.
func runHashPassword() error {
	password, err := readPassword()
	if err != nil {
		return fmt.Errorf("read password: %w", err)
	}
	if password == "" {
		return errors.New("password must not be empty")
	}
	if term.IsTerminal(int(os.Stdin.Fd())) {
		fmt.Fprint(os.Stderr, "Confirm ")
		confirmation, err := readPassword()
		if err != nil {
			return fmt.Errorf("confirm password: %w", err)
		}
		if confirmation != password {
			return errors.New("passwords do not match")
		}
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

	return readPasswordInput(os.Stdin)
}

func readPasswordInput(input io.Reader) (string, error) {
	data, err := io.ReadAll(io.LimitReader(input, 4097))
	if err != nil {
		return "", err
	}
	if len(data) > 4096 {
		return "", errors.New("password input is too large")
	}
	return string(bytes.TrimRight(data, "\r\n")), nil
}
