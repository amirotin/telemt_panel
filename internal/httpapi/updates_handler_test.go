package httpapi

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/host"
	"github.com/amirotin/telemt_panel/internal/host/hosttest"
	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
	"github.com/amirotin/telemt_panel/internal/update"
)

// newFakeTelemtWithVersion is newFakeTelemtHTTP (sse_test.go) plus
// /v1/system/info, which the update engine's TelemtTarget needs for
// CurrentVersion.
func newFakeTelemtWithVersion(t *testing.T, version string) *telemt.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/system/info":
			fmt.Fprintf(w, `{"ok":true,"data":{"version":%q,"target_arch":"x86_64","target_os":"linux","build_profile":"release","process_started_at_epoch_secs":0,"uptime_seconds":0,"config_path":"","config_hash":"","config_reload_count":0},"revision":"r"}`, version)
		case "/v1/health":
			fmt.Fprint(w, `{"ok":true,"data":{"status":"ok","read_only":false},"revision":"r"}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return telemt.New(srv.URL, "")
}

// buildTarGz returns a single-file tar.gz, for a fake release asset.
func buildTarGz(t *testing.T, name string, content []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(content)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatalf("tar header: %v", err)
	}
	if _, err := tw.Write(content); err != nil {
		t.Fatalf("tar write: %v", err)
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

// fakeGitHub serves a GitHub-shaped /repos/*/releases listing plus asset
// bytes at /assets/*, for tests that drive the update engine's
// checking/downloading/verifying phases against a real (fake) HTTP server.
// releases/assets are set after construction, since a release's
// BrowserDownloadURL needs the server's own URL, only known once it's
// already listening.
type fakeGitHub struct {
	*httptest.Server
	releases []update.Release
	assets   map[string][]byte
}

func newFakeGitHub(t *testing.T) *fakeGitHub {
	t.Helper()
	f := &fakeGitHub{assets: make(map[string][]byte)}
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(f.releases)
	})
	mux.HandleFunc("/assets/", func(w http.ResponseWriter, r *http.Request) {
		data, ok := f.assets[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(data)
	})
	f.Server = httptest.NewServer(mux)
	t.Cleanup(f.Close)
	return f
}

// newUpdatesTestServer builds a logged-in Server whose updateEngine is
// replaced with one wired against a fake GitHub server (releaseSrv) and
// runner — every other Server dependency (store, hub, auth) is the same
// real wiring newTestServer/newSSETestServer use elsewhere in this
// package. version is the telemt target's fake current version; the
// returned tarball bytes are registered as the "v2.0.0" release's asset,
// matching x86_64/musl (the Engine's fixed test Arch/Variant below).
func newUpdatesTestServer(t *testing.T, runner host.Runner, telemtVersion string) (*Server, *http.Cookie, *update.Engine) {
	t.Helper()
	tc := newFakeTelemtWithVersion(t, telemtVersion)

	binDir := t.TempDir()
	telemtBinPath := filepath.Join(binDir, "telemt")
	panelBinPath := filepath.Join(binDir, "panel")
	os.WriteFile(telemtBinPath, []byte("old-telemt"), 0o755)
	os.WriteFile(panelBinPath, []byte("old-panel"), 0o755)

	tarBytes := buildTarGz(t, "telemt", []byte("new-telemt"))
	assetName := update.AssetName("telemt", "x86_64", "musl")
	sum := sha256.Sum256(tarBytes)
	releaseSrv := newFakeGitHub(t)
	releaseSrv.assets["/assets/"+assetName] = tarBytes
	releaseSrv.assets["/assets/"+assetName+".sha256"] = []byte(hex.EncodeToString(sum[:]) + "  " + assetName + "\n")
	releaseSrv.releases = []update.Release{{
		Tag: "v2.0.0",
		Assets: []update.Asset{
			{Name: assetName, BrowserDownloadURL: releaseSrv.URL + "/assets/" + assetName},
			{Name: assetName + ".sha256", BrowserDownloadURL: releaseSrv.URL + "/assets/" + assetName + ".sha256"},
		},
	}}

	hash, err := auth.HashPassword(testPassword)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	cfg := &config.Config{Auth: config.AuthConfig{Username: "admin", PasswordHash: hash}}
	st, err := store.NewMemory("")
	if err != nil {
		t.Fatalf("store.NewMemory: %v", err)
	}
	hb := hub.New(hub.Config{}, tc)
	t.Cleanup(hb.Close)

	srv := New(cfg, tc, st, hb, "1.0.0")
	t.Cleanup(srv.limiter.Stop)
	t.Cleanup(srv.subLimiter.Stop)

	gh := update.NewClient()
	gh.BaseURL = releaseSrv.URL
	engine := update.NewEngine(update.EngineConfig{
		Runner: runner,
		Store:  st,
		Targets: map[string]update.Target{
			update.TargetTelemt: &update.TelemtTarget{Client: tc, RepoName: "owner/telemt", BinaryPath_: telemtBinPath, ServiceName_: "telemt"},
			update.TargetPanel:  &update.PanelTarget{Version_: "1.0.0", RepoName: "owner/panel", BinaryPath_: panelBinPath, ServiceName_: "panel"},
		},
		StagingDir: t.TempDir(),
		Github:     gh,
		Hub:        hb,
		Arch:       "x86_64",
		Variant:    "musl",
	})
	srv.updateEngine = engine
	srv.autoUpdater = update.NewAutoUpdater(st, engine)

	h := srv.Handler()
	_, cookie := login(t, h, "admin", testPassword)
	if cookie == nil {
		t.Fatal("expected a successful login")
	}
	return srv, cookie, engine
}

func TestHandleGetUpdates_ReturnsBothTargets(t *testing.T) {
	runner := &hosttest.Runner{}
	srv, cookie, _ := newUpdatesTestServer(t, runner, "v1.0.0")

	r := httptest.NewRequest("GET", "/api/updates", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	var got updatesStatusView
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.LockHeld {
		t.Error("LockHeld = true, want false (no run started)")
	}
	if len(got.Targets) != 2 {
		t.Fatalf("targets = %+v, want 2 entries", got.Targets)
	}
	byName := map[string]targetStatusView{}
	for _, tv := range got.Targets {
		byName[tv.Target] = tv
	}
	if byName[update.TargetTelemt].CurrentVersion != "v1.0.0" {
		t.Errorf("telemt current_version = %q, want v1.0.0", byName[update.TargetTelemt].CurrentVersion)
	}
	if byName[update.TargetPanel].CurrentVersion != "1.0.0" {
		t.Errorf("panel current_version = %q, want 1.0.0", byName[update.TargetPanel].CurrentVersion)
	}
}

func TestHandleApplyUpdate_AcceptsThenLocksOutASecondRun(t *testing.T) {
	release := make(chan struct{})
	runner := &hosttest.Runner{RunFunc: func(op host.Op) (host.Output, error) {
		if op.Kind == host.OpRestartService {
			<-release
		}
		return host.Output{}, nil
	}}
	srv, cookie, engine := newUpdatesTestServer(t, runner, "v1.0.0")

	r := mutatingJSON(t, "POST", "/api/updates/telemt/apply", cookie, applyUpdateRequest{Version: "v2.0.0"})
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202: %s", w.Code, w.Body)
	}

	r2 := mutatingJSON(t, "POST", "/api/updates/panel/apply", cookie, applyUpdateRequest{Version: "v2.0.0"})
	w2 := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w2, r2)
	if w2.Code != http.StatusConflict {
		t.Fatalf("second apply status = %d, want 409: %s", w2.Code, w2.Body)
	}
	var errBody map[string]string
	json.Unmarshal(w2.Body.Bytes(), &errBody)
	if errBody["code"] != "update_locked" {
		t.Errorf("error code = %q, want update_locked", errBody["code"])
	}

	entries, err := srv.st.ListAudit(20)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	found := false
	for _, e := range entries {
		if e.Action == "update.apply" && e.Subject == "telemt" {
			found = true
		}
	}
	if !found {
		t.Error("audit log missing update.apply entry")
	}

	close(release)
	deadline := time.Now().Add(2 * time.Second)
	for engine.LockHeld() {
		if time.Now().After(deadline) {
			t.Fatal("engine never unlocked")
		}
	}
}

func TestHandleApplyUpdate_UnknownTarget(t *testing.T) {
	srv, cookie, _ := newUpdatesTestServer(t, &hosttest.Runner{}, "v1.0.0")

	r := mutatingJSON(t, "POST", "/api/updates/bogus/apply", cookie, applyUpdateRequest{Version: "v2.0.0"})
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

// TestNew_DockerServiceManager_RestartTargetsUseContainerNames covers
// finding 3 end to end, through the real Server.New wiring (unlike
// newUpdatesTestServer above, which replaces srv.updateEngine entirely and
// so never exercises New's own service-name resolution). It deliberately
// gives the telemt/panel *service* names and *container* names disjoint,
// telltale substrings so a wiring regression back to the systemd-style
// service name — or a rejection by an allow-list that only knows the
// service name — is unambiguous in the resulting error.
//
// direct mode's Docker ServiceManager really execs `docker restart
// <container>` (host.OSCmdRunner is not injectable through New()); this
// test never needs that to succeed — install-binary succeeds first
// (proving the staging/binary-path plumbing is fine), and whatever the
// restart-service op's outcome is, Docker.Restart's error always embeds
// the exact service string ExecOp resolved and let past the allow-list
// check, which is what this test actually asserts on.
func TestNew_DockerServiceManager_RestartTargetsUseContainerNames(t *testing.T) {
	tc := newFakeTelemtWithVersion(t, "v1.0.0")

	binDir := t.TempDir()
	telemtBinPath := filepath.Join(binDir, "telemt")
	panelBinPath := filepath.Join(binDir, "panel")
	if err := os.WriteFile(telemtBinPath, []byte("old-telemt"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(panelBinPath, []byte("old-panel"), 0o755); err != nil {
		t.Fatal(err)
	}

	// New()'s engine uses the real host's detected arch/libc (it has no
	// override hook), so the fake release's asset must match those, not a
	// fixed "x86_64"/"musl" the way newUpdatesTestServer's manually-built
	// engine does.
	arch := update.DetectArch()
	variant := update.DetectLibc(update.DefaultProbe())
	tarBytes := buildTarGz(t, "telemt", []byte("new-telemt"))
	assetName := update.AssetName("telemt", arch, variant)
	sum := sha256.Sum256(tarBytes)
	releaseSrv := newFakeGitHub(t)
	releaseSrv.assets["/assets/"+assetName] = tarBytes
	releaseSrv.assets["/assets/"+assetName+".sha256"] = []byte(hex.EncodeToString(sum[:]) + "  " + assetName + "\n")
	releaseSrv.releases = []update.Release{{
		Tag: "v2.0.0",
		Assets: []update.Asset{
			{Name: assetName, BrowserDownloadURL: releaseSrv.URL + "/assets/" + assetName},
			{Name: assetName + ".sha256", BrowserDownloadURL: releaseSrv.URL + "/assets/" + assetName + ".sha256"},
		},
	}}

	hash, err := auth.HashPassword(testPassword)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	cfg := &config.Config{
		Auth:    config.AuthConfig{Username: "admin", PasswordHash: hash},
		DataDir: t.TempDir(),
		Updates: config.UpdatesConfig{
			TelemtRepo: "owner/telemt", PanelRepo: "owner/panel",
			TelemtBinaryPath: telemtBinPath, PanelBinaryPath: panelBinPath,
		},
		Host: config.HostConfig{
			ServiceManager:  "docker",
			TelemtService:   "telemt-service-name",
			PanelService:    "panel-service-name",
			TelemtContainer: "telemt-container-name",
			PanelContainer:  "panel-container-name",
		},
		// "direct" forces host.NewDirectRunner regardless of the test
		// process's euid — SelectRunner's doc comment: an operator's
		// explicit choice is taken at face value.
		Privileges: config.PrivilegesConfig{Mode: "direct"},
	}
	st, err := store.NewMemory("")
	if err != nil {
		t.Fatalf("store.NewMemory: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	hb := hub.New(hub.Config{}, tc)
	t.Cleanup(hb.Close)

	srv := New(cfg, tc, st, hb, "1.0.0")
	t.Cleanup(srv.limiter.Stop)
	t.Cleanup(srv.subLimiter.Stop)
	srv.SetUpdateGithubBaseURL(releaseSrv.URL)

	if srv.svcMgr.Kind() != host.KindDocker {
		t.Fatalf("svcMgr.Kind() = %q, want docker (test setup problem, not the fix under test)", srv.svcMgr.Kind())
	}

	err = srv.updateEngine.Apply(context.Background(), update.TargetTelemt, "v2.0.0")
	if err == nil {
		t.Fatal("want a non-nil error (no real \"telemt-container-name\" docker container exists in the test environment)")
	}
	msg := err.Error()
	if strings.Contains(msg, "is not in the allowed service list") {
		t.Fatalf("Apply error = %q — the container name was rejected by the allow-list, want it accepted", msg)
	}
	if !strings.Contains(msg, "telemt-container-name") {
		t.Fatalf("Apply error = %q, want it to reference the docker container name \"telemt-container-name\"", msg)
	}
	if strings.Contains(msg, "telemt-service-name") {
		t.Fatalf("Apply error = %q, want it NOT to reference the systemd-style service name \"telemt-service-name\" — a docker host must restart the container, not that unit", msg)
	}
}

func TestHandleAutoUpdate_GetPutRoundTripAndValidation(t *testing.T) {
	srv, cookie, _ := newUpdatesTestServer(t, &hosttest.Runner{}, "v1.0.0")
	h := srv.Handler()

	get := func() autoUpdateSettingsView {
		r := httptest.NewRequest("GET", "/api/updates/auto", nil)
		r.AddCookie(cookie)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("GET status = %d, want 200: %s", w.Code, w.Body)
		}
		var v autoUpdateSettingsView
		json.Unmarshal(w.Body.Bytes(), &v)
		return v
	}

	initial := get()
	if initial.Telemt != "off" || initial.Panel != "off" || initial.Interval != "6h0m0s" {
		t.Errorf("defaults = %+v, want off/off/6h0m0s", initial)
	}

	put := func(body autoUpdateSettingsView) int {
		r := mutatingJSON(t, "PUT", "/api/updates/auto", cookie, body)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}

	if code := put(autoUpdateSettingsView{Telemt: "apply", Panel: "check", Interval: "2h"}); code != http.StatusNoContent {
		t.Fatalf("PUT status = %d, want 204", code)
	}
	updated := get()
	if updated.Telemt != "apply" || updated.Panel != "check" || updated.Interval != "2h0m0s" {
		t.Errorf("after PUT = %+v, want apply/check/2h0m0s", updated)
	}

	if code := put(autoUpdateSettingsView{Telemt: "bogus", Panel: "off", Interval: "2h"}); code != http.StatusBadRequest {
		t.Errorf("PUT invalid mode status = %d, want 400", code)
	}
	if code := put(autoUpdateSettingsView{Telemt: "off", Panel: "off", Interval: "10m"}); code != http.StatusBadRequest {
		t.Errorf("PUT interval below floor status = %d, want 400", code)
	}
}

func TestSSEUpdateTopic_DeliversRunProgress(t *testing.T) {
	runner := &hosttest.Runner{}
	srv, cookie, engine := newUpdatesTestServer(t, runner, "v1.0.0")

	panelSrv := httptest.NewServer(srv.Handler())
	t.Cleanup(panelSrv.Close)

	req, err := http.NewRequest(http.MethodGet, panelSrv.URL+"/api/events?topics=update", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(cookie)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	frames := readSSEFrames(resp.Body)

	if err := engine.StartApply(update.TargetTelemt, "v2.0.0"); err != nil {
		t.Fatalf("StartApply: %v", err)
	}

	var sawDone bool
	for i := 0; i < 12; i++ {
		f := nextFrame(t, frames, 2*time.Second)
		if f.event != "update" {
			t.Fatalf("frame event = %q, want update: %+v", f.event, f)
		}
		if strings.Contains(f.data, `"phase":"done"`) {
			sawDone = true
			break
		}
	}
	if !sawDone {
		t.Fatal("never observed a phase=done event on the update topic")
	}
}
