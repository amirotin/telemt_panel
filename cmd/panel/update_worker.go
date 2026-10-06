package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/host"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
	"github.com/amirotin/telemt_panel/internal/update"
)

func runUpdateWorkerCommand(args []string, output io.Writer) error {
	flags := flag.NewFlagSet("update-worker", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	protocol := flags.Bool("protocol", false, "print worker protocol")
	recovering := flags.Bool("recover", false, "restore interrupted update before startup")
	checkIdle := flags.Bool("check-idle", false, "check installer-held worker lock has no pending task")
	configPath := flags.String("config", "", "panel configuration path")
	stateDir := flags.String("state-dir", "", "independent worker state directory")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("update-worker does not accept positional arguments")
	}
	if *protocol {
		_, err := fmt.Fprintln(output, update.WorkerProtocol)
		return err
	}
	if *stateDir == "" || !filepath.IsAbs(*stateDir) {
		return errors.New("update-worker requires an absolute --state-dir")
	}
	if *checkIdle {
		return update.WorkerStateIdle(*stateDir)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	saved, err := update.ReadWorkerRecoveryConfig(*stateDir)
	var cfg *config.Config
	if err == nil {
		cfg = &config.Config{}
		if err := json.Unmarshal(saved, cfg); err != nil {
			return fmt.Errorf("load saved worker configuration: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	} else if *recovering {
		return update.RecoverWorker(ctx, update.WorkerConfig{StateDir: *stateDir})
	} else {
		if *configPath == "" {
			return errors.New("update-worker requires --config")
		}
		source, err := loadStartupSource(*configPath)
		if err != nil {
			return err
		}
		cfg = source.Config
	}
	if filepath.Clean(*stateDir) != filepath.Clean(cfg.WorkerStateDir()) {
		return errors.New("worker state directory differs from configured data directory")
	}
	worker, err := makeUpdateWorkerConfig(cfg, *stateDir)
	if err != nil {
		return err
	}
	if *recovering {
		return update.RecoverWorker(ctx, worker)
	}
	return update.RunWorker(ctx, worker)
}

func makeUpdateWorkerConfig(cfg *config.Config, stateDir string) (update.WorkerConfig, error) {
	probe := host.DefaultProbe()
	manager := host.NewServiceManager(cfg.Host.ServiceManager, probe, host.OSCmdRunner)
	if cfg.Host.ServiceManager == host.KindCustom {
		manager = host.NewCustom(cfg.Host.TelemtService, cfg.Host.PanelService, cfg.Host.Commands, host.OSCmdRunner)
	}
	telemtService, panelService := cfg.Host.TelemtService, cfg.Host.PanelService
	if manager.Kind() == host.KindDocker {
		telemtService, panelService = cfg.Host.TelemtContainer, cfg.Host.PanelContainer
	}
	allow := host.AllowLists{
		TargetBinaries: map[string]string{update.TargetPanel: cfg.Updates.PanelBinaryPath, update.TargetTelemt: cfg.Updates.TelemtBinaryPath},
		BinaryPaths:    []string{cfg.Updates.PanelBinaryPath, cfg.Updates.PanelBinaryPath + ".bak", cfg.Updates.TelemtBinaryPath, cfg.Updates.TelemtBinaryPath + ".bak"},
		StagingPrefix:  filepath.Join(cfg.DataDir, "staging"),
		Services:       []string{panelService, telemtService}, ControlServices: []string{panelService, telemtService},
	}
	var runner host.Runner
	var launch func(context.Context, []string) error
	switch {
	case cfg.Privileges.Mode == host.PrivilegesModeManual:
		return update.WorkerConfig{}, host.ErrPrivilegesUnavailable
	case cfg.Privileges.Mode == host.PrivilegesModeDirect || (os.Geteuid() == 0 && cfg.Privileges.Mode != host.PrivilegesModeSudo):
		runner = host.NewDirectRunner(allow, manager, nil)
	default:
		sudo := host.NewSudoCmdRunner(host.OSCmdRunner)
		manager = host.NewServiceManager(manager.Kind(), probe, sudo)
		if cfg.Host.ServiceManager == host.KindCustom {
			manager = host.NewCustom(telemtService, panelService, cfg.Host.Commands, sudo)
		}
		runner = host.NewCommandSudoRunner(allow, manager, nil, sudo, host.NewSudoStdinCmdRunner(host.OSStdinCmdRunner))
		launch = func(ctx context.Context, argv []string) error {
			_, _, err := sudo(ctx, argv[0], argv[1:]...)
			return err
		}
	}
	tc := telemt.New(cfg.Telemt.URL, cfg.Telemt.AuthHeader)
	panelURL, err := updateWorkerPanelURL(cfg)
	if err != nil {
		return update.WorkerConfig{}, err
	}
	// This probe connects directly to the configured local listener, which may
	// serve a self-signed certificate. It sends no credentials or application data.
	transport := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, DialContext: (&net.Dialer{Timeout: 5 * time.Second}).DialContext}
	health := &update.WorkerHealthProbe{PanelURL: panelURL, Telemt: tc, Client: &http.Client{Transport: transport, Timeout: 5 * time.Second}}
	saved, err := json.Marshal(cfg)
	if err != nil {
		return update.WorkerConfig{}, err
	}
	paths := []string{cfg.Path, filepath.Join(cfg.DataDir, panelStateFile)}
	if cfg.Store.Driver == "sqlite" {
		paths = append(paths, cfg.Store.Path, cfg.Store.Path+"-wal", cfg.Store.Path+"-shm")
	}
	return update.WorkerConfig{
		StateDir: stateDir, DataDir: cfg.DataDir, RecoveryConfig: saved, SnapshotPaths: paths, Health: health.Check, Launch: launch,
		ProbeCandidate: func(ctx context.Context, path string) error {
			ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			out, err := exec.CommandContext(ctx, path, "update-worker", "--protocol").Output()
			if err != nil || strings.TrimSpace(string(out)) != "1" {
				return errors.New("candidate does not support independent updates; use the installer for this version")
			}
			return nil
		},
		Engine: update.EngineConfig{Runner: runner, StagingDir: allow.StagingPrefix, GithubToken: cfg.Updates.GithubToken, BuildVariant: store.Variant,
			Targets: map[string]update.Target{
				update.TargetPanel:  &update.PanelTarget{RepoName: cfg.Updates.PanelRepo, BinaryPath_: cfg.Updates.PanelBinaryPath, ServiceName_: panelService},
				update.TargetTelemt: &update.TelemtTarget{Client: tc, RepoName: cfg.Updates.TelemtRepo, BinaryPath_: cfg.Updates.TelemtBinaryPath, ServiceName_: telemtService},
			},
		},
	}, nil
}

func updateWorkerPanelURL(cfg *config.Config) (string, error) {
	name, port, err := net.SplitHostPort(cfg.Listen)
	if err != nil {
		return "", err
	}
	if name == "" || name == "0.0.0.0" {
		name = "127.0.0.1"
	}
	if name == "::" {
		name = "::1"
	}
	scheme := "http"
	if cfg.TLS.Mode != "" && cfg.TLS.Mode != "http" {
		scheme = "https"
	}
	return scheme + "://" + net.JoinHostPort(name, port) + strings.TrimRight(cfg.BasePath, "/") + "/api/health", nil
}
