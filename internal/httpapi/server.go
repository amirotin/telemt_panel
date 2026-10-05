// Package httpapi wires the panel's HTTP surface. Contract: api/openapi.yaml.
// v1.x convention (differs from 0.x): no {ok,data} envelope — plain status
// codes, success bodies are the resource, errors are {code, message}.
package httpapi

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/branding"
	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/geography"
	"github.com/amirotin/telemt_panel/internal/geoip"
	"github.com/amirotin/telemt_panel/internal/host"
	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/paneltls"
	"github.com/amirotin/telemt_panel/internal/quotareset"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/subpage"
	"github.com/amirotin/telemt_panel/internal/telemt"
	"github.com/amirotin/telemt_panel/internal/update"
	"github.com/amirotin/telemt_panel/internal/webui"
)

// Server holds the panel's HTTP dependencies.
type Server struct {
	quotaResets    *quotareset.Manager
	quotaSchedules *quotareset.Scheduler
	access         *panelAccess
	tlsManager     *paneltls.Manager
	subTLSManager  *paneltls.Manager
	cfg            *config.Config
	tc             *telemt.Client
	st             store.Store
	hub            *hub.Hub
	limiter        *auth.Limiter
	sessions       *auth.SessionGuard
	subSvc         *subpage.Service
	subIndex       *subpage.Index
	subLimiter     *subpage.RateLimiter
	version        string

	svcMgr         host.ServiceManager
	logSrc         host.LogSource
	logStreams     *logStreamRegistry
	privilegesMode string
	// runner and telemtServiceName back POST /api/telemt/restart — the same
	// Runner/service-name resolution the update engine uses for its own
	// restart-after-install step (see New's telemtServiceName comment
	// below), reused here for an admin-triggered restart with no update
	// attached.
	runner              host.Runner
	telemtServiceName   string
	serviceStartAllowed bool
	serviceStopAllowed  bool
	// logStreamHeartbeat is GET /api/events/logs' heartbeat period; defaults
	// to logStreamHeartbeatInterval (logs_handler.go), overridable by tests
	// in this package the same way svcMgr/logSrc are.
	logStreamHeartbeat time.Duration
	// sseAfterSubscribeHook, if set, runs in handleEvents (sse.go)
	// immediately after hub.Subscribe registers the live channel and before
	// replay/snapshot is computed — nil in production. sse_test.go sets it
	// to deterministically land a broadcast in that exact window, the race
	// P3.11's dedup fix covers, which real concurrency alone is too narrow
	// to hit reliably.
	sseAfterSubscribeHook func()

	updateEngine *update.Engine
	onReady      func() error
	autoUpdater  *update.AutoUpdater
	geoip        *geoip.Manager
	geography    *geography.Service
	branding     *branding.Manager

	// webUI serves the embedded SPA (internal/webui) — registered as the
	// mux's catch-all "/" pattern in Handler(), after every /api/ and
	// /sub/ route, so it never shadows them. nil only if the embedded
	// dist/ somehow fails to read (see webui.New's doc comment: this is
	// effectively unreachable in practice), in which case Handler serves
	// the API/subpage surface with no SPA behind it rather than panicking.
	webUI http.Handler
}

// EngineOptions supplies process lifecycle information to the update engine.
type EngineOptions struct {
	PanelLifecycleContext context.Context
	OnReady               func() error
}

// New builds the handler tree.
func New(cfg *config.Config, tc *telemt.Client, st store.Store, hb *hub.Hub, version string, options ...EngineOptions) *Server {
	var engineOptions EngineOptions
	if len(options) > 0 {
		engineOptions = options[0]
	}
	probe := host.DefaultProbe()
	svcMgr := configuredServiceManager(cfg.Host, cfg.Host.ServiceManager, probe, host.OSCmdRunner)
	logSrc := host.NewLogSource(cfg.Host.LogSource, cfg.Host.LogFile, svcMgr.Kind(), probe, host.OSCmdRunner, host.OSProcessStarter, host.DefaultLogPollInterval)

	euid := os.Geteuid()
	// BinaryPaths carries each target's live install path plus a fixed
	// ".bak" sibling — the update engine's rollback step writes the
	// pre-update binary there via install-binary before overwriting the
	// live path, then restore-binary reads it back on failure. Both ops'
	// allow-list check (privexec.go) requires an exact member of this
	// list, so the sibling has to be listed explicitly, not just the live
	// path.
	// telemtServiceName/panelServiceName are the update engine's restart
	// targets — resolved the same way resolveLogicalService (host_handler.go)
	// resolves GET /api/host's restart/log calls, so a docker host's
	// restart-service op targets the CONTAINER name, not a systemd-style
	// unit name that means nothing to `docker restart`.
	telemtServiceName, _ := resolveLogicalService("telemt", svcMgr.Kind(), cfg.Host)
	panelServiceName, _ := resolveLogicalService("panel", svcMgr.Kind(), cfg.Host)

	allow := host.AllowLists{
		TargetBinaries: map[string]string{"panel": cfg.Updates.PanelBinaryPath, "telemt": cfg.Updates.TelemtBinaryPath},
		HelperPath:     cfg.Privileges.HelperPath,
		PolicyPath:     cfg.Privileges.PolicyPath,
		BinaryPaths: []string{
			cfg.Updates.TelemtBinaryPath, cfg.Updates.TelemtBinaryPath + ".bak",
			cfg.Updates.PanelBinaryPath, cfg.Updates.PanelBinaryPath + ".bak",
		},
		StagingPrefix: stagingPrefix(cfg.DataDir),
		Services:      allowedServiceNames(cfg.Host),
	}
	if serviceBindingsDiffer(svcMgr.Kind(), telemtServiceName, panelServiceName) {
		allow.ControlServices = []string{telemtServiceName}
	}

	// Sudo is another transport for the same host operations, not a second
	// updater. Its ServiceManager is constructed from the already-resolved
	// host kind, so Telemt and panel restarts always use the same init-system
	// implementation and differ only by their allow-listed service name.
	sudoRun := host.NewSudoCmdRunner(host.OSCmdRunner)
	sudoSvcMgr := configuredServiceManager(cfg.Host, svcMgr.Kind(), probe, sudoRun)
	var sudoRunner host.Runner = host.NewSudoRunner(allow, sudoSvcMgr, logSrc, sudoRun)
	sudoAvailable := false
	if cfg.Privileges.Mode == host.PrivilegesModeSudo || ((cfg.Privileges.Mode == "" || cfg.Privileges.Mode == host.PrivilegesModeAuto) && euid != 0) {
		policyRun := host.NewSudoPolicyCmdRunner(host.OSCmdRunner)
		policySvcMgr := configuredServiceManager(cfg.Host, svcMgr.Kind(), probe, policyRun)
		policyRunner := host.NewSudoRunner(allow, policySvcMgr, logSrc, policyRun)
		probeCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		probeOps := updatePrivilegeProbeOps(allow.StagingPrefix, cfg.Updates, telemtServiceName, panelServiceName)
		sudoAvailable = host.ProbeRunner(probeCtx, policyRunner, probeOps)
		if sudoAvailable {
			if err := host.CheckPrivilegedPolicy(probeCtx, allow, sudoRun); err != nil {
				slog.Warn("privileged update policy requires repair", "err", err)
				sudoAvailable = false
			}
		}
		cancel()
	}
	runner, privilegesMode := host.SelectRunner(host.RunnerSelectionOptions{
		Mode: cfg.Privileges.Mode, EUID: euid,
		Allow: allow, ServiceManager: svcMgr, LogSource: logSrc,
		SudoRunner: sudoRunner, SudoAvailable: sudoAvailable,
	})
	var startAllowed, stopAllowed bool
	if privilegesMode == host.PrivilegesModeSudo && len(allow.ControlServices) != 0 {
		policyRun := host.NewSudoPolicyCmdRunner(host.OSCmdRunner)
		policyManager := configuredServiceManager(cfg.Host, svcMgr.Kind(), probe, policyRun)
		policyRunner := host.NewSudoRunner(allow, policyManager, logSrc, policyRun)
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		startAllowed, stopAllowed = host.ProbeServiceControls(ctx, policyRunner, telemtServiceName)
		cancel()
	}

	telemtTarget := &update.TelemtTarget{
		Client:       tc,
		RepoName:     cfg.Updates.TelemtRepo,
		BinaryPath_:  cfg.Updates.TelemtBinaryPath,
		ServiceName_: telemtServiceName,
	}
	panelTarget := &update.PanelTarget{
		Version_:     version,
		RepoName:     cfg.Updates.PanelRepo,
		BinaryPath_:  cfg.Updates.PanelBinaryPath,
		ServiceName_: panelServiceName,
	}
	updateEngine := update.NewEngine(update.EngineConfig{
		Runner:                runner,
		Store:                 st,
		Targets:               map[string]update.Target{update.TargetTelemt: telemtTarget, update.TargetPanel: panelTarget},
		StagingDir:            allow.StagingPrefix,
		GithubToken:           cfg.Updates.GithubToken,
		Hub:                   hb,
		BuildVariant:          store.Variant,
		PanelLifecycleContext: engineOptions.PanelLifecycleContext,
		RequireReadiness:      engineOptions.PanelLifecycleContext != nil,
	})

	appearance := branding.New(st, cfg.BasePath)
	webUI, err := webui.New(webui.Embedded(), cfg.BasePath)
	if err != nil {
		// See the webUI field's doc comment — unreachable outside a
		// corrupted embed, logged rather than fatal so the API/subpage
		// surface still comes up.
		slog.Error("build webui handler", "err", err)
	}
	if webUI != nil {
		webUI.SetBranding(appearance.Public)
	}

	s := &Server{
		access:              newPanelAccess(),
		tlsManager:          paneltls.New(cfg.TLS, cfg.Listen),
		subTLSManager:       paneltls.New(cfg.Subpage.TLS, cfg.Subpage.Listen),
		cfg:                 cfg,
		tc:                  tc,
		st:                  st,
		hub:                 hb,
		limiter:             auth.NewLimiter(),
		sessions:            auth.NewSessionGuard(st, func() time.Duration { return cfg.Auth.SessionTTLDuration() }, time.Now),
		subSvc:              subpage.NewService(cfg.Subpage.Secret, cfg.Subpage.BasePath, st),
		subIndex:            subpage.NewIndex(cfg.Subpage.Secret, tc, st),
		subLimiter:          subpage.NewRateLimiter(),
		version:             version,
		svcMgr:              svcMgr,
		logSrc:              logSrc,
		logStreams:          newLogStreamRegistry(),
		privilegesMode:      privilegesMode,
		logStreamHeartbeat:  logStreamHeartbeatInterval,
		updateEngine:        updateEngine,
		onReady:             engineOptions.OnReady,
		autoUpdater:         update.NewAutoUpdater(st, updateEngine),
		geoip:               geoip.NewManager(cfg.DataDir, st),
		branding:            appearance,
		runner:              runner,
		telemtServiceName:   telemtServiceName,
		serviceStartAllowed: startAllowed,
		serviceStopAllowed:  stopAllowed,
		webUI:               webUI,
	}
	s.quotaResets = quotareset.New(tc, s.quotaResetEvent)
	s.quotaSchedules = quotareset.NewScheduler(st, s.quotaResets)
	buildTimeout := time.Duration(cfg.Geography.BuildTimeoutSecs) * time.Second
	geoDeps := geography.Dependencies{
		History: st, GeoIP: s.geoip, State: st,
		BuildTimeout: buildTimeout, RequestTimeout: buildTimeout + 2*time.Second,
	}
	if hb != nil {
		geoDeps.Live = hb
	}
	s.geography = geography.NewService(geoDeps)
	return s
}

// updatePrivilegeProbeOps is the complete privileged command surface both
// targets need for apply and rollback. Sudo mode is enabled only when every
// operation is permitted; checking one target or only the happy path would
// make the shared updater fail halfway through a real rollback.
func updatePrivilegeProbeOps(staging string, cfg config.UpdatesConfig, telemtService, panelService string) []host.Op {
	return []host.Op{
		{Kind: host.OpInstallBinary, Args: map[string]string{host.ArgStaging: filepath.Join(update.StagingRunDir(staging, update.TargetTelemt), "backup"), host.ArgDest: cfg.TelemtBinaryPath + ".bak"}},
		{Kind: host.OpInstallBinary, Args: map[string]string{host.ArgStaging: filepath.Join(update.StagingRunDir(staging, update.TargetTelemt), "bin"), host.ArgDest: cfg.TelemtBinaryPath}},
		{Kind: host.OpRestoreBinary, Args: map[string]string{host.ArgBackup: cfg.TelemtBinaryPath + ".bak", host.ArgDest: cfg.TelemtBinaryPath}},
		{Kind: host.OpInstallBinary, Args: map[string]string{host.ArgStaging: filepath.Join(update.StagingRunDir(staging, update.TargetPanel), "backup"), host.ArgDest: cfg.PanelBinaryPath + ".bak"}},
		{Kind: host.OpInstallBinary, Args: map[string]string{host.ArgStaging: filepath.Join(update.StagingRunDir(staging, update.TargetPanel), "bin"), host.ArgDest: cfg.PanelBinaryPath}},
		{Kind: host.OpRestoreBinary, Args: map[string]string{host.ArgBackup: cfg.PanelBinaryPath + ".bak", host.ArgDest: cfg.PanelBinaryPath}},
		{Kind: host.OpRestartService, Args: map[string]string{host.ArgService: telemtService}},
		{Kind: host.OpRestartService, Args: map[string]string{host.ArgService: panelService}},
	}
}

// stagingPrefix returns the update engine's staging directory prefix
// (AllowLists.StagingPrefix and EngineConfig.StagingDir): under dataDir
// when the panel has one configured, or a fixed directory under the OS
// temp dir when data_dir is "" — a legitimate, documented config (RAM-only
// state). filepath.Join(dataDir, "staging") with dataDir=="" would
// otherwise yield the relative path "staging", which validatePathShape
// (privexec.go) rejects on every single install op ("must be absolute")
// and which os.MkdirAll would otherwise create under the process's
// current working directory.
func stagingPrefix(dataDir string) string {
	if dataDir == "" {
		return filepath.Join(os.TempDir(), "telemt-panel-staging")
	}
	return filepath.Join(dataDir, "staging")
}

// allowedServiceNames returns every service/container name that may
// legitimately appear as an ExecOp "service" argument for the telemt and
// panel logical services. Both the plain name and the docker container
// name are included whenever they differ, rather than only whichever one
// matches the service manager's detected Kind() at startup: restart-service
// resolves its name from svcMgr.Kind() while read-journal resolves from
// the (independently configurable) log source's Kind(), so the two can
// legitimately disagree — see resolveLogicalService's doc comment.
func allowedServiceNames(cfg config.HostConfig) []string {
	names := []string{cfg.TelemtService, cfg.PanelService}
	if cfg.TelemtContainer != "" && cfg.TelemtContainer != cfg.TelemtService {
		names = append(names, cfg.TelemtContainer)
	}
	if cfg.PanelContainer != "" && cfg.PanelContainer != cfg.PanelService {
		names = append(names, cfg.PanelContainer)
	}
	return names
}

// SetUpdateGithubBaseURL overrides the update engine's GitHub API base URL
// (update.Engine.SetGithubBaseURL). Test-only hook: TestAPIOnlyDegradation
// (degradation_test.go) uses it to point GET /api/updates at an httptest
// fake instead of the real GitHub API, so that "stay green forever" test
// never depends on the network. Production callers never call this — New's
// wiring is unaffected either way.
func (s *Server) SetUpdateGithubBaseURL(url string) {
	s.updateEngine.SetGithubBaseURL(url)
}

// chain wraps h with mws, applied outermost-first (mws[0] runs first).
func chain(h http.Handler, mws ...func(http.Handler) http.Handler) http.Handler {
	for i := len(mws) - 1; i >= 0; i-- {
		h = mws[i](h)
	}
	return h
}

// Handler returns the routed HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		response := map[string]any{
			"status":        "ok",
			"version":       s.version,
			"variant":       store.Variant,
			"drivers":       store.AvailableDrivers(),
			"state_durable": s.st.StateDurable(),
		}
		writeJSON(w, http.StatusOK, response)
	})

	// protect wraps a handler with the CSRF and session checks shared by
	// every authenticated /api/* route except /api/auth/login (which has
	// its own checks) and /sub/* (no cookie, no mutations, out of scope
	// here).
	protect := func(h http.HandlerFunc) http.Handler {
		return chain(h, auth.CSRF(s.cfg), auth.RequireSession(s.st, s.cfg, s.sessions))
	}
	// Disabled authentication has no sessions or credential-management API.
	// Keep these routes explicit; normal panel APIs still retain CSRF checks.
	sessionOnly := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if s.cfg.Auth.Disabled {
				auth.WriteError(w, http.StatusForbidden, "auth_disabled", "panel authentication is disabled in the configuration")
				return
			}
			h(w, r)
		}
	}

	mux.HandleFunc("POST /api/auth/login", sessionOnly(s.handleLogin))
	mux.HandleFunc("GET /api/auth/methods", s.handleAuthMethods)
	mux.Handle("POST /api/auth/logout", protect(sessionOnly(s.handleLogout)))
	mux.Handle("GET /api/auth/me", protect(s.handleMe))
	mux.Handle("GET /api/settings/tls", protect(func(w http.ResponseWriter, r *http.Request) {
		subscription, ok := accessTarget(w, r)
		if !ok {
			return
		}
		if subscription {
			writeJSON(w, http.StatusOK, s.subTLSManager.Status())
			return
		}
		writeJSON(w, http.StatusOK, s.tlsManager.Status())
	}))
	mux.Handle("GET /api/settings/tls/config", protect(s.handleGetTLSConfig))
	mux.Handle("POST /api/settings/tls/prepare", protect(s.handlePrepareTLS))
	mux.Handle("PUT /api/settings/tls/config", protect(s.handlePutTLSConfig))
	mux.Handle("POST /api/settings/tls/restart", protect(s.handleRestartTLS))
	mux.Handle("GET /api/auth/sessions", protect(sessionOnly(s.handleListSessions)))
	mux.Handle("DELETE /api/auth/sessions", protect(sessionOnly(s.handleRevokeOtherSessions)))
	mux.Handle("DELETE /api/auth/sessions/{sessionId}", protect(sessionOnly(s.handleRevokeSession)))
	mux.Handle("POST /api/auth/webauthn/register/begin", protect(sessionOnly(s.handleWebAuthnRegisterBegin)))
	mux.Handle("POST /api/auth/webauthn/register/finish", protect(sessionOnly(s.handleWebAuthnRegisterFinish)))
	mux.HandleFunc("POST /api/auth/webauthn/login/begin", sessionOnly(s.handleWebAuthnLoginBegin))
	mux.HandleFunc("POST /api/auth/webauthn/login/finish", sessionOnly(s.handleWebAuthnLoginFinish))
	mux.Handle("DELETE /api/auth/webauthn/credentials/{credentialId}", protect(sessionOnly(s.handleWebAuthnCredentialDelete)))

	mux.Handle("GET /api/telemt/info", protect(s.handleTelemtInfo))
	mux.Handle("POST /api/users/operations/quota-reset/prepare", protect(s.handlePrepareQuotaReset))
	mux.Handle("POST /api/users/operations/quota-reset", protect(s.handleStartQuotaReset))
	mux.Handle("GET /api/users/operations/quota-reset", protect(s.handleQuotaResetStatus))
	mux.Handle("GET /api/settings/quota-schedule", protect(s.handleQuotaSchedule))
	mux.Handle("PUT /api/settings/quota-schedule", protect(s.handleSaveQuotaSchedule))
	mux.Handle("POST /api/settings/quota-schedule/preview", protect(s.handlePreviewQuotaSchedule))
	mux.Handle("GET /api/users/{username}/quota-schedule", protect(s.handleQuotaSchedule))
	mux.Handle("PUT /api/users/{username}/quota-schedule", protect(s.handleSaveUserQuotaSchedule))
	mux.Handle("GET /api/telemt/config", protect(s.handleGetTelemtConfig))
	mux.Handle("GET /api/telemt/web-access", protect(s.handleGetTelemtWebAccess))
	mux.Handle("PUT /api/telemt/web-access/users/{username}", protect(s.handlePutTelemtUserWebAccess))
	mux.Handle("GET /api/telemt/config/catalog", protect(s.handleGetTelemtConfigCatalog))
	mux.Handle("PATCH /api/telemt/config", protect(s.handlePatchTelemtConfig))
	mux.Handle("GET /api/telemt/config/toml", protect(s.handleGetTelemtConfigTOML))
	mux.Handle("POST /api/telemt/config/toml/preview", protect(s.handlePreviewTelemtConfigTOML))
	mux.Handle("PATCH /api/telemt/config/toml", protect(s.handlePatchTelemtConfigTOML))
	mux.Handle("POST /api/telemt/reload", protect(s.handleTelemtReload))
	mux.Handle("GET /api/telemt/reload/{id}", protect(s.handleTelemtReloadStatus))
	mux.Handle("POST /api/telemt/restart", protect(s.handleTelemtRestart))
	mux.Handle("GET /api/telemt/service", protect(s.handleTelemtService))
	mux.Handle("POST /api/telemt/start", protect(s.handleTelemtStart))
	mux.Handle("POST /api/telemt/stop", protect(s.handleTelemtStop))
	mux.Handle("GET /api/telemt/zero", protect(s.handleGetTelemtZero))
	mux.Handle("GET /api/telemt/tls-fingerprints", protect(s.handleGetTelemtTLSFingerprints))
	mux.Handle("GET /api/telemt/web/sessions", protect(s.handleGetTelemtWebSessions))
	mux.Handle("GET /api/telemt/web/sessions/{ref}", protect(s.handleGetTelemtWebSession))
	mux.Handle("POST /api/telemt/web/sessions/close", protect(s.handlePostTelemtWebSessionsClose))
	mux.Handle("GET /api/telemt/web/operations/{id}", protect(s.handleGetTelemtWebOperation))

	mux.Handle("GET /api/host", protect(s.handleHost))
	mux.Handle("GET /api/logs/tail", protect(s.handleLogsTail))
	mux.Handle("GET /api/audit", protect(s.handleGetAudit))
	mux.Handle("GET /api/history", protect(s.handleGetHistory))
	mux.Handle("GET /api/history/events", protect(s.handleGetHistoryEvents))
	mux.Handle("GET /api/users/{username}/traffic-history", protect(s.handleGetUserTrafficHistory))
	mux.Handle("GET /api/users/{username}/ip-history", protect(s.handleGetUserIPHistory))
	mux.Handle("POST /api/users/{username}/ip-history/reset", protect(s.handleResetUserIPHistory))
	mux.Handle("POST /api/users/{username}/traffic/reset", protect(s.handleResetUserTraffic))
	mux.Handle("GET /api/traffic/summary", protect(s.handleGetTrafficSummary))
	mux.Handle("GET /api/traffic/users", protect(s.handleGetTrafficUsers))
	mux.Handle("POST /api/traffic/reset", protect(s.handleResetAllUserTraffic))
	mux.HandleFunc("GET /api/branding", s.handlePublicBranding)
	mux.HandleFunc("GET /api/branding/logo", s.handleBrandingAsset)
	mux.HandleFunc("GET /api/branding/icon", s.handleBrandingAsset)
	mux.Handle("GET /api/settings/branding", protect(s.handleGetBranding))
	mux.Handle("PUT /api/settings/branding", protect(s.handlePutBranding))
	mux.Handle("GET /api/settings/links", protect(s.handleGetLinkSettings))
	mux.Handle("PUT /api/settings/links", protect(s.handlePutLinkSettings))
	mux.Handle("GET /api/settings/storage", protect(s.handleGetStorageSettings))
	mux.Handle("PUT /api/settings/storage", protect(s.handlePutStorageSettings))
	mux.Handle("POST /api/settings/storage/purge", protect(s.handlePurgeStorageHistory))
	mux.Handle("GET /api/settings/geoip", protect(s.handleGetGeoIPSettings))
	mux.Handle("PUT /api/settings/geoip", protect(s.handlePutGeoIPSettings))
	mux.Handle("POST /api/settings/geoip/update", protect(s.handleUpdateGeoIP))
	mux.Handle("GET /api/geography", protect(s.handleGetGeography))
	mux.Handle("GET /api/geography/locations", protect(s.handleGetGeographyLocations))
	mux.Handle("GET /api/geography/users", protect(s.handleGetGeographyUsers))
	mux.Handle("GET /api/settings/geography", protect(s.handleGetGeographySettings))
	mux.Handle("PUT /api/settings/geography", protect(s.handlePutGeographySettings))

	mux.Handle("GET /api/updates", protect(s.handleGetUpdates))
	mux.Handle("POST /api/updates/{target}/apply", protect(s.handleApplyUpdate))
	mux.Handle("GET /api/updates/auto", protect(s.handleGetAutoUpdate))
	mux.Handle("PUT /api/updates/auto", protect(s.handlePutAutoUpdate))

	mux.Handle("GET /api/events", protect(s.handleEvents))
	mux.Handle("GET /api/events/logs", protect(s.handleEventsLogs))
	mux.Handle("HEAD /api/events/logs", protect(s.handleProbeLogStream))
	mux.Handle("GET /api/snapshot", protect(s.handleSnapshot))

	mux.Handle("GET /api/users", protect(s.handleListUsers))
	mux.Handle("POST /api/users", protect(s.handleCreateUser))
	mux.Handle("GET /api/users/{username}", protect(s.handleGetUser))
	mux.Handle("PATCH /api/users/{username}", protect(s.handlePatchUser))
	mux.Handle("DELETE /api/users/{username}", protect(s.handleDeleteUser))
	mux.Handle("POST /api/users/{username}/reset-quota", protect(s.handleResetQuota))
	mux.Handle("POST /api/users/{username}/rotate-secret", protect(s.handleRotateSecret))
	mux.Handle("PUT /api/users/{username}/enabled", protect(s.handleSetEnabled))
	mux.Handle("GET /api/users/{username}/sublink", protect(s.handleGetSublink))
	mux.Handle("POST /api/users/{username}/sublink", protect(s.handlePostSublink))

	apiHandler := apiJSONFallback(mux)
	if s.webUI == nil {
		return acceptBasePath(s.cfg.BasePath, apiHandler)
	}
	// The embedded SPA (internal/webui) sits behind this mux, not
	// registered as a "/" pattern on it directly: ServeMux's own
	// most-specific-match algorithm can't tell "no /api/ route matches
	// this path" apart from "the catch-all matched" once a catch-all
	// exists on the same mux — that would swallow apiJSONFallback's
	// pattern=="" 404/405 detection for /api/* and the retired /sub/*
	// namespace. spaRouter (below) dispatches by namespace
	// prefix instead (/api, /sub, everything else) so both keep exactly
	// their own behavior and webUI only ever sees a path neither owns.
	return acceptBasePath(s.cfg.BasePath, &spaRouter{mux: mux, api: apiHandler, webUI: s.webUI})
}

// acceptBasePath requires the configured prefix. Proxies must preserve it.
func acceptBasePath(base string, next http.Handler) http.Handler {
	if base == "" {
		return next
	}
	stripped := http.StripPrefix(base, next)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if pathIsOrUnder(r.URL.Path, base) {
			stripped.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
	})
}

// spaRouter is Handler()'s top-level dispatcher once the embedded SPA is
// available: exactly three namespaces, checked in order.
//
//   - /api and everything under /api/ always go through api
//     (apiJSONFallback's JSON {code,message} 404/405 for an unmatched
//     route, unchanged from pre-M3 other than fix round 1's finding 5:
//     a bare "/api" now gets the same treatment as "/api/nope").
//   - /sub is retired on the admin listener and returns a plain 404,
//     never an SPA fallback. Public pages use SubscriptionHandler.
//   - Everything else falls through to webUI, which answers with the SPA
//     shell (index.html) for a client-side route or a hashed asset.
type spaRouter struct {
	mux   *http.ServeMux
	api   http.Handler
	webUI http.Handler
}

func (rt *spaRouter) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case pathIsOrUnder(r.URL.Path, "/api"):
		rt.api.ServeHTTP(w, r)
	case pathIsOrUnder(r.URL.Path, "/sub"):
		rt.mux.ServeHTTP(w, r)
	default:
		rt.webUI.ServeHTTP(w, r)
	}
}

// headerCapture is a throwaway http.ResponseWriter used only to run
// ServeMux's synthetic "no route matched" handler far enough to read the
// Allow header it sets for a 405 — never written to the real response,
// discarded immediately after.
type headerCapture struct {
	header http.Header
}

func newHeaderCapture() *headerCapture { return &headerCapture{header: make(http.Header)} }

func (c *headerCapture) Header() http.Header         { return c.header }
func (c *headerCapture) Write(b []byte) (int, error) { return len(b), nil }
func (c *headerCapture) WriteHeader(int)             {}

// pathIsOrUnder reports whether path is exactly prefix (e.g. a bare
// "/api" or "/sub", no trailing slash) or begins with prefix+"/". Used to
// dispatch a whole namespace consistently regardless of whether the
// request happens to have anything after the prefix — a bare "/api" gets
// exactly the same JSON-404 treatment as "/api/nope" (fix round 1, finding
// 5); a bare "/sub" gets the same mux-owned treatment as "/sub/{token}"
// (see spaRouter below).
func pathIsOrUnder(path, prefix string) bool {
	return path == prefix || strings.HasPrefix(path, prefix+"/")
}

// apiJSONFallback wraps mux so an unmatched /api/* request — an unknown
// path, or a known path with the wrong method — returns the panel's
// {code,message} JSON error envelope (api/openapi.yaml Error) instead of
// ServeMux's default plain-text 404/405. Non-/api/ paths, including
// /sub/*, pass through untouched and keep their existing plain-text
// behavior — the audit's scope is the JSON API surface only.
//
// mux.Handler(r) reports the empty pattern "" exactly when ServeMux itself
// would fall back to a synthetic handler (net/http's findHandler): either a
// bare 404 or, when the path matches a route under a different method, a
// 405 with an Allow header already set. Running that synthetic handler
// against a headerCapture (rather than the real ResponseWriter) reads the
// Allow header, if any, without letting its plain-text body reach the
// client.
func apiJSONFallback(mux *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !pathIsOrUnder(r.URL.Path, "/api") {
			mux.ServeHTTP(w, r)
			return
		}
		if h, pattern := mux.Handler(r); pattern == "" {
			capture := newHeaderCapture()
			h.ServeHTTP(capture, r)
			if allow := capture.header.Get("Allow"); allow != "" {
				w.Header().Set("Allow", allow)
				auth.WriteError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
				return
			}
			auth.WriteError(w, http.StatusNotFound, "not_found", "not found")
			return
		}
		mux.ServeHTTP(w, r)
	})
}

// Run serves until ctx is canceled, then drains connections.
func (s *Server) Run(ctx context.Context) error {
	stopQuota := context.AfterFunc(ctx, s.quotaResets.Close)
	defer stopQuota()
	stopAccess := context.AfterFunc(ctx, s.access.cancel)
	defer stopAccess()
	// Cancel owned workers on every return path, including listen failures.
	ctx, cancel := context.WithCancel(ctx)
	var wg sync.WaitGroup
	defer func() {
		cancel()
		s.access.close()
		s.quotaResets.Close()
		s.sessions.Close()
		s.logStreams.Close()
		if s.geography != nil {
			s.geography.Close()
		}
		if s.geoip != nil {
			s.geoip.Close()
		}
		wg.Wait()
		s.updateEngine.Close()
		s.hub.Close()
		s.limiter.Stop()
		s.subLimiter.Stop()
		s.tlsManager.Close()
		s.subTLSManager.Close()
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		s.autoUpdater.Run(ctx)
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		s.quotaSchedules.Run(ctx)
	}()
	if s.geoip != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.geoip.Run(ctx)
		}()
	}

	tlsConfig, challengeHandler, err := s.tlsManager.Prepare()
	if err != nil {
		return err
	}
	var subscription *http.Server
	var subChallenge http.Handler
	if s.cfg.Subpage.Enabled {
		var subTLS *tls.Config
		if s.cfg.TLS.Mode == "acme" && s.cfg.Subpage.TLS == s.cfg.TLS {
			// One domain/cache has one renewal owner even across two ports.
			s.subTLSManager.Close()
			s.subTLSManager = s.tlsManager
			subTLS = tlsConfig.Clone()
		} else {
			subTLS, subChallenge, err = s.subTLSManager.Prepare()
			if err != nil {
				return fmt.Errorf("subscription: %w", err)
			}
		}
		subscription = &http.Server{Addr: s.cfg.Subpage.Listen, Handler: s.SubscriptionHandler(), TLSConfig: subTLS,
			ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	}
	challengeHandler = paneltls.CombineChallenges(challengeHandler, subChallenge)
	s.access.mux = paneltls.NewChallengeMux(challengeHandler)

	srv := s.panelHTTPServer(tlsConfig)
	// Shutdown waits for every in-flight handler to return, but an SSE
	// handler only returns when its subscriber channel closes or the
	// client disconnects — neither of which "drain connections" below
	// causes on its own. Closing the hub here, as soon as Shutdown starts
	// rather than after it returns, closes every subscriber channel
	// immediately so streaming handlers exit right away instead of
	// stalling Shutdown up to its own deadline. hub.Close is idempotent, so
	// the deferred call above (belt-and-braces for the non-Shutdown return
	// paths) is safe to also run.
	srv.RegisterOnShutdown(s.hub.Close)
	// Same rationale as hub.Close above: a log stream (GET
	// /api/events/logs) only returns when its context is canceled or the
	// client disconnects, so it needs its own shutdown hook to end
	// promptly rather than stall Shutdown.
	srv.RegisterOnShutdown(s.logStreams.Close)
	srv.RegisterOnShutdown(s.sessions.Close)

	srv.RegisterOnShutdown(func() {
		if s.updateEngine.HasActiveRun() {
			slog.Warn("update in progress at shutdown; will reconcile on next boot")
		}
	})
	var challenge *http.Server
	if challengeHandler != nil {
		challenge = &http.Server{Addr: ":80", Handler: s.access.mux,
			ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second,
			WriteTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 << 10}
	}
	return serveListeners(ctx, srv, challenge, func() error {
		if s.onReady != nil {
			if err := s.onReady(); err != nil {
				return err
			}
		}
		s.updateEngine.MarkReady()
		return nil
	}, subscription)
}

func (s *Server) panelHTTPServer(tlsConfig *tls.Config) *http.Server {
	return &http.Server{TLSConfig: tlsConfig, Addr: s.cfg.Listen, Handler: s.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 60 * time.Second, IdleTimeout: 120 * time.Second, MaxHeaderBytes: 16 << 10}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("encode response", "err", err)
	}
}
