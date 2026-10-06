package update

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/host"
	"github.com/amirotin/telemt_panel/internal/store"
)

// These tests create real accounts, units and sudoers on disposable CI runners.
// All four gates are required; an ordinary root test run cannot enable them.
func requireNativeWorkerHost(t *testing.T) {
	t.Helper()
	if os.Getenv("GITHUB_ACTIONS") != "true" || os.Getenv("TP_NATIVE_TEST") != "1" || os.Geteuid() != 0 {
		t.Skip("requires disposable GitHub Actions runner, TP_NATIVE_TEST=1 and root")
	}
	init, err := os.ReadFile("/proc/1/comm")
	if err != nil || strings.TrimSpace(string(init)) != "systemd" {
		t.Skip("requires systemd as PID 1")
	}
}

type nativeWorkerFixture struct {
	Root           string `json:"root"`
	User           string `json:"user"`
	UID            int    `json:"uid"`
	GID            int    `json:"gid"`
	PanelUnit      string `json:"panel_unit"`
	WorkerUnit     string `json:"worker_unit"`
	Systemctl      string `json:"systemctl"`
	ReleaseURL     string `json:"release_url"`
	PanelAddress   string `json:"panel_address"`
	Arch           string `json:"arch"`
	HoldReadiness  bool   `json:"hold_readiness"`
	CrashAfterStop bool   `json:"crash_after_stop"`
}

func (f nativeWorkerFixture) binary() string   { return filepath.Join(f.Root, "panel") }
func (f nativeWorkerFixture) dataDir() string  { return filepath.Join(f.Root, "data") }
func (f nativeWorkerFixture) stateDir() string { return filepath.Join(f.dataDir(), "updater") }
func (f nativeWorkerFixture) configPath() string {
	return filepath.Join(f.Root, "fixture.json")
}
func (f nativeWorkerFixture) healthURL() string {
	return "http://" + f.PanelAddress + "/healthz"
}

type nativePanelMarker struct {
	Version  string `json:"version"`
	Behavior string `json:"behavior"`
}

const nativeMarkerPrefix = "\nTP_NATIVE_MARKER="

// TestNativeWorkerLifecycle exercises production queue, worker, transport and
// readiness code across actual systemd cgroups and a nonroot service identity.
func TestNativeWorkerLifecycle(t *testing.T) {
	requireNativeWorkerHost(t)
	for _, scenario := range []string{"success", "broken-executable", "failed-start", "wrong-version", "unhealthy", "crash-recovery", "worker-crash-after-stop"} {
		t.Run(scenario, func(t *testing.T) {
			f := newNativeWorkerFixture(t, scenario)
			oldPID := nativeServicePID(t, f, f.PanelUnit)
			if oldPID <= 0 {
				t.Fatal("old panel has no running process")
			}
			nativeSubmitFromPanel(t, f)
			if scenario == "worker-crash-after-stop" {
				var pausedPID int
				nativeWait(t, 20*time.Second, func() (bool, error) {
					data, err := os.ReadFile(filepath.Join(f.stateDir(), "stopped-panel-worker-pid"))
					if err != nil {
						return false, err
					}
					pausedPID, err = strconv.Atoi(strings.TrimSpace(string(data)))
					return pausedPID > 0, err
				})
				if pid := nativeServicePID(t, f, f.WorkerUnit); pid != pausedPID {
					t.Fatalf("worker left the post-stop crash point: current=%d paused=%d", pid, pausedPID)
				}
				if pid := nativeServicePID(t, f, f.PanelUnit); pid != 0 {
					t.Fatalf("panel is still running at worker crash point: PID=%d", pid)
				}
				state, err := loadWorkerState(f.stateDir())
				if err != nil || state.Task == nil || !state.Task.StopIntent || state.Task.PublishIntent {
					t.Fatalf("crash point must be after stop intent and before publication: %+v, %v", state, err)
				}
				nativeSystemctl(t, f, "kill", "--signal=KILL", "--kill-whom=all", f.WorkerUnit)
			}
			if scenario == "success" || scenario == "crash-recovery" {
				nativeWaitPhase(t, f, PhaseHealth, 20*time.Second)
				workerPID := nativeServicePID(t, f, f.WorkerUnit)
				panelPID := nativeServicePID(t, f, f.PanelUnit)
				if workerPID <= 0 || panelPID <= 0 || panelPID == oldPID {
					t.Fatalf("independent update processes: old=%d new=%d worker=%d", oldPID, panelPID, workerPID)
				}
				if _, err := os.Stat(fmt.Sprintf("/proc/%d", oldPID)); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("old panel survived its stop while worker progressed: %v", err)
				}
				for _, pid := range []int{workerPID, panelPID} {
					nativeAssertProcessUID(t, pid, f.UID)
				}
				panelGroup := nativeSystemctl(t, f, "show", "--property=ControlGroup", "--value", f.PanelUnit)
				workerGroup := nativeSystemctl(t, f, "show", "--property=ControlGroup", "--value", f.WorkerUnit)
				if panelGroup == "" || workerGroup == "" || panelGroup == workerGroup || strings.HasPrefix(workerGroup, panelGroup+"/") {
					t.Fatalf("worker shares panel cgroup: panel=%q worker=%q", panelGroup, workerGroup)
				}
				if scenario == "success" {
					nativeAssertBusyAcrossProcesses(t, f)
					if err := os.WriteFile(filepath.Join(f.dataDir(), "candidate-ready"), []byte("ready"), 0o644); err != nil {
						t.Fatal(err)
					}
				} else {
					nativeSystemctl(t, f, "kill", "--signal=KILL", "--kill-whom=all", f.WorkerUnit)
					nativeWait(t, 5*time.Second, func() (bool, error) {
						out, err := nativeCommand(f.Systemctl, "show", "--property=MainPID", "--value", f.WorkerUnit)
						return strings.TrimSpace(string(out)) == "0", err
					})
					nativeSystemctl(t, f, "stop", f.PanelUnit)
					if err := os.WriteFile(f.binary(), []byte("not an executable after interrupted publication\n"), 0o755); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(f.configPath(), []byte("invalid current configuration"), 0o644); err != nil {
						t.Fatal(err)
					}
					nativeSystemctl(t, f, "reset-failed", f.WorkerUnit)
					nativeSystemctl(t, f, "start", f.PanelUnit)
				}
			}
			wantPhase, wantVersion := PhaseRolledBack, "v1.0.0"
			if scenario == "success" {
				wantPhase, wantVersion = PhaseDone, "v1.1.0"
			}
			nativeWaitPhase(t, f, wantPhase, 30*time.Second)
			probe := WorkerHealthProbe{PanelURL: f.healthURL(), Timeout: 5 * time.Second, Interval: 25 * time.Millisecond}
			if err := probe.Check(context.Background(), TargetPanel, wantVersion); err != nil {
				t.Fatalf("final runtime version/readiness: %v", err)
			}
			if scenario == "worker-crash-after-stop" {
				restarts, err := strconv.Atoi(nativeSystemctl(t, f, "show", "--property=NRestarts", "--value", f.WorkerUnit))
				if err != nil || restarts < 1 {
					t.Fatalf("systemd did not automatically retry the killed worker: restarts=%d, %v", restarts, err)
				}
				if pid := nativeServicePID(t, f, f.PanelUnit); pid <= 0 || pid == oldPID {
					t.Fatalf("automatic worker retry did not restart the old runtime: old PID=%d current PID=%d", oldPID, pid)
				}
			}
			nativeWait(t, 5*time.Second, func() (bool, error) {
				for _, path := range []string{f.binary() + ".bak", f.binary() + ".tmp", f.binary() + ".bak.tmp", StagingRunDir(filepath.Join(f.dataDir(), "staging"), TargetPanel), filepath.Join(f.stateDir(), "snapshot")} {
					if _, err := os.Stat(path); err == nil {
						return false, nil
					} else if !errors.Is(err, os.ErrNotExist) {
						return false, err
					}
				}
				return true, nil
			})
			if scenario != "success" {
				for name, want := range map[string]string{"panel-state.json": "old state", "panel.toml": "old configuration"} {
					if data, err := os.ReadFile(filepath.Join(f.dataDir(), name)); err != nil || string(data) != want {
						t.Fatalf("snapshot %s=%q, want %q: %v", name, data, want, err)
					}
				}
				if _, err := os.Stat(filepath.Join(f.dataDir(), "history.db-wal")); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("candidate WAL remains after rollback: %v", err)
				}
			}
			if scenario == "crash-recovery" {
				receipt, err := os.ReadFile(filepath.Join(f.stateDir(), "recovery-executables"))
				if err != nil || !strings.Contains(string(receipt), f.binary()+".bak") {
					t.Fatalf("startup did not recover via backup executable: %q, %v", receipt, err)
				}
			}
			info, err := os.Stat(f.binary())
			if err != nil || info.Mode().Perm() != 0o755 || info.Sys().(*syscall.Stat_t).Uid != 0 {
				t.Fatalf("installed binary owner/mode changed: %v, %v", info, err)
			}
		})
	}
}

func newNativeWorkerFixture(t *testing.T, scenario string) nativeWorkerFixture {
	t.Helper()
	root, err := os.MkdirTemp("/run", "tp-update-native-")
	if err != nil {
		t.Fatal(err)
	}
	f := nativeWorkerFixture{Root: root, User: "tpnat" + strings.TrimPrefix(filepath.Base(root), "tp-update-native-"), HoldReadiness: scenario == "success" || scenario == "crash-recovery", CrashAfterStop: scenario == "worker-crash-after-stop"}
	f.PanelUnit, f.WorkerUnit = f.User+"-panel.service", f.User+"-worker.service"
	unitPaths := []string{filepath.Join("/run/systemd/system", f.PanelUnit), filepath.Join("/run/systemd/system", f.WorkerUnit)}
	sudoers := filepath.Join("/etc/sudoers.d", f.User)
	userCreated := false
	unitsLoaded := false
	t.Cleanup(func() {
		if t.Failed() && f.Systemctl != "" {
			out, _ := nativeCommand("journalctl", "--no-pager", "--output=short-precise", "-n", "180", "-u", f.PanelUnit, "-u", f.WorkerUnit)
			t.Logf("native unit journal:\n%s", out)
			if state, err := os.ReadFile(filepath.Join(f.stateDir(), "state.json")); err == nil {
				t.Logf("native worker state: %s", state)
			}
		}
		if unitsLoaded {
			if out, err := nativeCommand(f.Systemctl, "stop", f.WorkerUnit, f.PanelUnit); err != nil {
				t.Errorf("stop native fixture services during cleanup: %s: %v", out, err)
			}
			_, _ = nativeCommand(f.Systemctl, "kill", "--signal=KILL", "--kill-whom=all", f.WorkerUnit, f.PanelUnit)
		}
		for _, path := range append(unitPaths, sudoers) {
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				t.Errorf("remove fixture registration %s: %v", path, err)
			}
		}
		if unitsLoaded {
			if out, err := nativeCommand(f.Systemctl, "daemon-reload"); err != nil {
				t.Errorf("reload units after fixture cleanup: %s: %v", out, err)
			}
			_, _ = nativeCommand(f.Systemctl, "reset-failed", f.WorkerUnit, f.PanelUnit)
		}
		if userCreated {
			if out, err := nativeCommand("userdel", f.User); err != nil {
				t.Errorf("remove fixture user %s: %s: %v", f.User, out, err)
			}
		}
		if err := os.RemoveAll(root); err != nil {
			t.Errorf("remove fixture directory: %v", err)
		}
	})
	if err := os.Chmod(root, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"systemctl", "sudo", "install", "mv", "rm", "visudo", "useradd", "userdel"} {
		path, err := exec.LookPath(name)
		if err != nil {
			t.Fatalf("required native command %s: %v", name, err)
		}
		if name == "systemctl" {
			f.Systemctl = path
		}
	}
	if out, err := nativeCommand("useradd", "--system", "--user-group", "--no-create-home", "--shell", "/usr/sbin/nologin", f.User); err != nil {
		t.Fatalf("create fixture service user: %s: %v", out, err)
	}
	userCreated = true
	for flag, target := range map[string]*int{"-u": &f.UID, "-g": &f.GID} {
		out, err := nativeCommand("id", flag, f.User)
		if err != nil {
			t.Fatal(err)
		}
		*target, err = strconv.Atoi(strings.TrimSpace(string(out)))
		if err != nil || *target == 0 {
			t.Fatalf("invalid fixture identity %q: %v", out, err)
		}
	}
	for _, path := range []string{f.dataDir(), f.stateDir()} {
		if err := os.Mkdir(path, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chown(path, f.UID, f.GID); err != nil {
			t.Fatal(err)
		}
	}
	for name, data := range map[string]string{"panel-state.json": "old state", "panel.toml": "old configuration"} {
		nativeWrite(t, filepath.Join(f.dataDir(), name), []byte(data), 0o640, f.UID, f.GID)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	self, err := os.ReadFile(executable)
	if err != nil {
		t.Fatal(err)
	}
	nativeWrite(t, filepath.Join(root, "harness"), self, 0o755, 0, 0)
	nativeWrite(t, f.binary(), nativeMarkedExecutable(t, self, "v1.0.0", "healthy"), 0o755, 0, 0)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f.PanelAddress = listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	f.Arch = "x86_64"
	if runtime.GOARCH == "arm64" {
		f.Arch = "aarch64"
	}
	releases := newFakeReleaseServer(t)
	f.ReleaseURL = releases.URL
	candidate := nativeMarkedExecutable(t, self, "v1.1.0", scenario)
	if scenario == "broken-executable" {
		candidate = []byte("broken executable payload\n")
	}
	asset := AssetName("telemt-panel", f.Arch, "musl")
	url := releases.addAsset(asset, buildTarGz(t, "panel", candidate))
	releases.releases = []Release{{Tag: "v1.1.0", Assets: []Asset{{Name: asset, BrowserDownloadURL: url}}}}
	encoded, err := json.Marshal(f)
	if err != nil {
		t.Fatal(err)
	}
	nativeWrite(t, f.configPath(), encoded, 0o644, 0, 0)
	registration, err := json.Marshal(workerRegistration{Version: WorkerProtocol, Command: []string{f.Systemctl, "start", "--no-block", f.WorkerUnit}})
	if err != nil {
		t.Fatal(err)
	}
	nativeWrite(t, filepath.Join(f.stateDir(), "registration.json"), registration, 0o600, f.UID, f.GID)
	var grants []string
	for _, destination := range []string{f.binary(), f.binary() + ".bak"} {
		install, _ := exec.LookPath("install")
		move, _ := exec.LookPath("mv")
		grants = append(grants, install+" -m 0755 /dev/stdin "+destination+".tmp", move+" -f "+destination+".tmp "+destination)
	}
	remove, _ := exec.LookPath("rm")
	for _, suffix := range []string{".bak", ".tmp", ".bak.tmp"} {
		grants = append(grants, remove+" -f "+f.binary()+suffix)
	}
	for _, action := range []string{"start", "stop", "restart"} {
		grants = append(grants, f.Systemctl+" "+action+" "+f.PanelUnit)
	}
	grants = append(grants, f.Systemctl+" start --no-block "+f.WorkerUnit)
	nativeWrite(t, sudoers, []byte(f.User+" ALL=(root) NOPASSWD: "+strings.Join(grants, ", ")+"\n"), 0o440, 0, 0)
	if out, err := nativeCommand("visudo", "-c", "-f", sudoers); err != nil {
		t.Fatalf("native sudoers syntax: %s: %v", out, err)
	}
	wrapper := filepath.Join(root, "start-panel")
	wrapperBody := fmt.Sprintf("#!/bin/sh\nset -eu\nif TP_NATIVE_ROLE=recovery %s -test.run=^TestNativeRecoveryProcess$; then\n  :\nelif TP_NATIVE_ROLE=recovery %s.bak -test.run=^TestNativeRecoveryProcess$; then\n  :\nelse\n  exit 1\nfi\nexport TP_NATIVE_ROLE=panel\nexec %s -test.run=^TestNativePanelProcess$\n", f.binary(), f.binary(), f.binary())
	nativeWrite(t, wrapper, []byte(wrapperBody), 0o755, 0, 0)
	environment := fmt.Sprintf("Environment=GITHUB_ACTIONS=true TP_NATIVE_TEST=1 TP_NATIVE_FIXTURE=%s TP_NATIVE_STATE_DIR=%s\n", f.configPath(), f.stateDir())
	panelUnit := fmt.Sprintf("[Unit]\nDescription=Disposable native update fixture panel\nStartLimitIntervalSec=0\n[Service]\nType=notify\nNotifyAccess=main\nUser=%s\nGroup=%s\n%sExecStart=%s\nKillMode=control-group\nTimeoutStartSec=8s\nTimeoutStopSec=5s\n", f.User, f.User, environment, wrapper)
	workerUnit := fmt.Sprintf("[Unit]\nDescription=Disposable independent update worker\nStartLimitIntervalSec=0\n[Service]\nType=oneshot\nUser=%s\nGroup=%s\n%sEnvironment=TP_NATIVE_ROLE=worker\nExecStart=%s -test.run=^TestNativeWorkerProcess$\nKillMode=control-group\nTimeoutStartSec=120s\nTimeoutStopSec=5s\n", f.User, f.User, environment, f.binary())
	if f.CrashAfterStop {
		workerUnit += "Restart=on-failure\nRestartSec=200ms\n"
	}
	nativeWrite(t, unitPaths[0], []byte(panelUnit), 0o644, 0, 0)
	nativeWrite(t, unitPaths[1], []byte(workerUnit), 0o644, 0, 0)
	unitsLoaded = true
	nativeSystemctl(t, f, "daemon-reload")
	nativeSystemctl(t, f, "start", f.PanelUnit)
	probe := WorkerHealthProbe{PanelURL: f.healthURL(), Timeout: 5 * time.Second, Interval: 25 * time.Millisecond}
	if err := probe.Check(context.Background(), TargetPanel, "v1.0.0"); err != nil {
		t.Fatalf("old panel fixture readiness: %v", err)
	}
	return f
}

func nativeMarkedExecutable(t *testing.T, executable []byte, version, behavior string) []byte {
	t.Helper()
	marker, err := json.Marshal(nativePanelMarker{Version: version, Behavior: behavior})
	if err != nil {
		t.Fatal(err)
	}
	result := append([]byte(nil), executable...)
	result = append(result, nativeMarkerPrefix...)
	return append(result, marker...)
}

func nativeWrite(t *testing.T, path string, data []byte, mode os.FileMode, uid, gid int) {
	t.Helper()
	if err := os.WriteFile(path, data, mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(path, uid, gid); err != nil {
		t.Fatal(err)
	}
}

func nativeCommand(name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

func nativeSystemctl(t *testing.T, f nativeWorkerFixture, args ...string) string {
	t.Helper()
	out, err := nativeCommand(f.Systemctl, args...)
	if err != nil {
		t.Fatalf("systemctl %q: %s: %v", args, out, err)
	}
	return strings.TrimSpace(string(out))
}

func nativeServicePID(t *testing.T, f nativeWorkerFixture, unit string) int {
	t.Helper()
	value := nativeSystemctl(t, f, "show", "--property=MainPID", "--value", unit)
	pid, err := strconv.Atoi(value)
	if err != nil {
		t.Fatalf("unit %s PID %q: %v", unit, value, err)
	}
	return pid
}

func nativeAssertProcessUID(t *testing.T, pid, uid int) {
	t.Helper()
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "Uid:") {
			fields := strings.Fields(line)
			if len(fields) != 5 || fields[1] != strconv.Itoa(uid) || fields[2] != strconv.Itoa(uid) {
				t.Fatalf("worker/panel changed service identity: %s", line)
			}
			return
		}
	}
	t.Fatalf("process %d has no UID receipt", pid)
}

func nativeWait(t *testing.T, timeout time.Duration, check func() (bool, error)) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var last error
	for time.Now().Before(deadline) {
		ok, err := check()
		if ok && err == nil {
			return
		}
		last = err
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("native condition did not settle within %s: %v", timeout, last)
}

func nativeWaitPhase(t *testing.T, f nativeWorkerFixture, phase string, timeout time.Duration) {
	t.Helper()
	nativeWait(t, timeout, func() (bool, error) {
		s, err := loadWorkerState(f.stateDir())
		if err != nil || s.Task == nil {
			return false, err
		}
		if s.Task.Status.Phase == phase {
			return true, nil
		}
		return false, fmt.Errorf("phase=%s detail=%s", s.Task.Status.Phase, s.Task.Status.Detail)
	})
}

func nativeSubmitFromPanel(t *testing.T, f nativeWorkerFixture) {
	t.Helper()
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Post("http://"+f.PanelAddress+"/submit", "application/json", nil)
	if err != nil {
		// The independent worker may stop the submitting panel before its
		// response arrives. The durable queue remains the acceptance receipt.
		s, stateErr := loadWorkerState(f.stateDir())
		if stateErr == nil && s.Task != nil && s.Task.Status.VersionTo == "v1.1.0" {
			return
		}
		t.Fatalf("panel submission: %v; durable state: %v", err, stateErr)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		t.Fatalf("panel submission HTTP %d: %s", response.StatusCode, body)
	}
}

type nativeClientResult struct {
	Busy  bool   `json:"busy"`
	Error string `json:"error"`
}

func nativeAssertBusyAcrossProcesses(t *testing.T, f nativeWorkerFixture) {
	t.Helper()
	type result struct {
		action string
		value  nativeClientResult
		err    error
	}
	results := make(chan result, 2)
	for _, action := range []string{"submit", "control"} {
		go func(action string) {
			path := filepath.Join(f.dataDir(), "client-"+action)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, filepath.Join(f.Root, "harness"), "-test.run=^TestNativeClientProcess$")
			cmd.Env = append(os.Environ(), "GITHUB_ACTIONS=true", "TP_NATIVE_TEST=1", "TP_NATIVE_ROLE=client", "TP_NATIVE_FIXTURE="+f.configPath(), "TP_NATIVE_STATE_DIR="+f.stateDir(), "TP_NATIVE_ACTION="+action, "TP_NATIVE_RESULT="+path)
			cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(f.UID), Gid: uint32(f.GID)}}
			out, err := cmd.CombinedOutput()
			if err != nil {
				results <- result{action: action, err: fmt.Errorf("client subprocess: %s: %w", out, err)}
				return
			}
			data, err := os.ReadFile(path)
			var value nativeClientResult
			if err == nil {
				err = json.Unmarshal(data, &value)
			}
			results <- result{action: action, value: value, err: err}
		}(action)
	}
	for range 2 {
		got := <-results
		if got.err != nil || !got.value.Busy {
			t.Fatalf("concurrent %s bypassed running worker: %+v, %v", got.action, got.value, got.err)
		}
	}
}

func nativeChildFixture(t *testing.T, role string) (nativeWorkerFixture, []byte) {
	t.Helper()
	if os.Getenv("GITHUB_ACTIONS") != "true" || os.Getenv("TP_NATIVE_TEST") != "1" || os.Getenv("TP_NATIVE_ROLE") != role {
		t.Skip("native subprocess helper")
	}
	if os.Geteuid() == 0 {
		t.Fatal("native panel/worker helper must use the fixture service UID")
	}
	stateDir := os.Getenv("TP_NATIVE_STATE_DIR")
	data, err := ReadWorkerRecoveryConfig(stateDir)
	if errors.Is(err, os.ErrNotExist) {
		data, err = os.ReadFile(os.Getenv("TP_NATIVE_FIXTURE"))
	}
	if err != nil {
		t.Fatal(err)
	}
	var fixture nativeWorkerFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.UID != os.Geteuid() || fixture.stateDir() != stateDir {
		t.Fatal("native helper identity/state directory mismatch")
	}
	return fixture, data
}

func nativeWorkerConfig(f nativeWorkerFixture, raw []byte) WorkerConfig {
	staging := filepath.Join(f.dataDir(), "staging")
	allow := host.AllowLists{BinaryPaths: []string{f.binary(), f.binary() + ".bak"}, TargetBinaries: map[string]string{TargetPanel: f.binary()}, StagingPrefix: staging, Services: []string{f.PanelUnit}, ControlServices: []string{f.PanelUnit}}
	run := host.NewSudoCmdRunner(host.OSCmdRunner)
	manager := host.NewSystemd(run)
	var runner host.Runner = host.NewCommandSudoRunner(allow, manager, nil, run, host.NewSudoStdinCmdRunner(host.OSStdinCmdRunner))
	if f.CrashAfterStop {
		runner = nativeStopPauseRunner{base: runner, service: f.PanelUnit, receipt: filepath.Join(f.stateDir(), "stopped-panel-worker-pid")}
	}
	github := NewClient()
	github.BaseURL = f.ReleaseURL
	health := WorkerHealthProbe{PanelURL: f.healthURL(), Timeout: 4 * time.Second, Interval: 25 * time.Millisecond, Client: &http.Client{Timeout: 300 * time.Millisecond}}
	if f.HoldReadiness {
		health.Timeout = 20 * time.Second
	}
	return WorkerConfig{
		StateDir: f.stateDir(), DataDir: f.dataDir(), RecoveryConfig: append(json.RawMessage(nil), raw...),
		SnapshotPaths: []string{filepath.Join(f.dataDir(), "panel-state.json"), filepath.Join(f.dataDir(), "panel.toml"), filepath.Join(f.dataDir(), "history.db-wal")},
		Health:        health.Check, Launch: nativeWorkerLaunch,
		Engine: EngineConfig{Runner: runner, Github: github, StagingDir: staging, Arch: f.Arch, Variant: "musl", Targets: map[string]Target{TargetPanel: &PanelTarget{Version_: "v1.0.0", RepoName: "native/fixture", BinaryPath_: f.binary(), ServiceName_: f.PanelUnit}}},
	}
}

// nativeStopPauseRunner pauses only the first completed stop. The durable marker
// lets a fresh init-started worker execute its rollback controls normally.
type nativeStopPauseRunner struct {
	base    host.Runner
	service string
	receipt string
}

func (r nativeStopPauseRunner) Run(ctx context.Context, op host.Op) (host.Output, error) {
	output, err := r.base.Run(ctx, op)
	if err != nil || op.Kind != host.OpStopService || op.Args[host.ArgService] != r.service {
		return output, err
	}
	file, err := os.OpenFile(r.receipt, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if errors.Is(err, os.ErrExist) {
		return output, nil
	}
	if err != nil {
		return output, err
	}
	_, writeErr := fmt.Fprintln(file, os.Getpid())
	if err := errors.Join(writeErr, file.Sync(), file.Close()); err != nil {
		return output, err
	}
	<-ctx.Done()
	return output, ctx.Err()
}

func nativeWorkerLaunch(ctx context.Context, argv []string) error {
	_, _, err := host.NewSudoCmdRunner(host.OSCmdRunner)(ctx, argv[0], argv[1:]...)
	return err
}

func TestNativeWorkerProcess(t *testing.T) {
	f, raw := nativeChildFixture(t, "worker")
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if err := RunWorker(ctx, nativeWorkerConfig(f, raw)); err != nil {
		t.Fatal(err)
	}
}

func TestNativeRecoveryProcess(t *testing.T) {
	f, raw := nativeChildFixture(t, "recovery")
	receipt, err := os.OpenFile(filepath.Join(f.stateDir(), "recovery-executables"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err == nil {
		_, err = fmt.Fprintln(receipt, executable)
	}
	if err = errors.Join(err, receipt.Close()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := RecoverWorker(ctx, nativeWorkerConfig(f, raw)); err != nil {
		t.Fatal(err)
	}
}

func TestNativeClientProcess(t *testing.T) {
	f, _ := nativeChildFixture(t, "client")
	client, err := NewWorkerClient(f.stateDir(), nativeWorkerLaunch)
	if err != nil {
		t.Fatal(err)
	}
	switch os.Getenv("TP_NATIVE_ACTION") {
	case "submit":
		err = client.Submit(context.Background(), TargetPanel, "v1.1.0", "v1.0.0")
	case "control":
		err = client.WithHostControl(func() error {
			_, _, commandErr := host.NewSudoCmdRunner(host.OSCmdRunner)(context.Background(), f.Systemctl, "stop", f.PanelUnit)
			return commandErr
		})
	default:
		t.Fatal("unsupported native client action")
	}
	result := nativeClientResult{Busy: errors.Is(err, ErrBusy)}
	if err != nil {
		result.Error = err.Error()
	}
	data, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(os.Getenv("TP_NATIVE_RESULT"), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestNativePanelProcess(t *testing.T) {
	f, _ := nativeChildFixture(t, "panel")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(executable)
	if err != nil {
		t.Fatal(err)
	}
	info, err := file.Stat()
	if err != nil {
		t.Fatal(err)
	}
	tail := make([]byte, 512)
	n, err := file.ReadAt(tail, max(0, info.Size()-int64(len(tail))))
	_ = file.Close()
	if err != nil && !errors.Is(err, io.EOF) {
		t.Fatal(err)
	}
	markerAt := bytes.LastIndex(tail[:n], []byte(nativeMarkerPrefix))
	if markerAt < 0 {
		t.Fatal("native panel executable has no version marker")
	}
	var marker nativePanelMarker
	if err := json.Unmarshal(tail[markerAt+len(nativeMarkerPrefix):n], &marker); err != nil {
		t.Fatal(err)
	}
	lock, err := store.AcquireDataDirLock(f.dataDir())
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if marker.Version == "v1.1.0" {
		for name, data := range map[string]string{"panel-state.json": "incompatible candidate state", "panel.toml": "incompatible candidate config", "history.db-wal": "candidate WAL"} {
			if err := os.WriteFile(filepath.Join(f.dataDir(), name), []byte(data), 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	if marker.Behavior == "failed-start" {
		t.Fatal("candidate exits before systemd readiness notification")
	}
	listener, err := net.Listen("tcp", f.PanelAddress)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		status, version := "ok", marker.Version
		if marker.Behavior == "wrong-version" {
			version = "v0.9.0"
		}
		if marker.Behavior == "unhealthy" {
			status = "starting"
		}
		if f.HoldReadiness && marker.Version == "v1.1.0" {
			if _, err := os.Stat(filepath.Join(f.dataDir(), "candidate-ready")); err != nil {
				status = "starting"
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": status, "version": version})
	})
	mux.HandleFunc("/submit", func(w http.ResponseWriter, r *http.Request) {
		client, err := NewWorkerClient(f.stateDir(), nativeWorkerLaunch)
		if err == nil {
			err = client.Submit(r.Context(), TargetPanel, "v1.1.0", marker.Version)
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusAccepted)
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: time.Second}
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.Serve(listener) }()
	notify, err := net.DialUnix("unixgram", nil, &net.UnixAddr{Name: os.Getenv("NOTIFY_SOCKET"), Net: "unixgram"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := notify.Write([]byte("READY=1")); err != nil {
		t.Fatal(err)
	}
	_ = notify.Close()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	select {
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			t.Error(err)
		}
	case err := <-serveErr:
		if !errors.Is(err, http.ErrServerClosed) {
			t.Fatal(err)
		}
	}
}
