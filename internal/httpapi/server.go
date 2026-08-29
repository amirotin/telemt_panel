// Package httpapi wires the panel's HTTP surface. Contract: api/openapi.yaml.
// v1.x convention (differs from 0.x): no {ok,data} envelope — plain status
// codes, success bodies are the resource, errors are {code, message}.
package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/host"
	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/subpage"
	"github.com/amirotin/telemt_panel/internal/telemt"
	"github.com/amirotin/telemt_panel/internal/update"
	"github.com/amirotin/telemt_panel/internal/webui"
)

// Server holds the panel's HTTP dependencies.
type Server struct {
	cfg        *config.Config
	tc         *telemt.Client
	st         store.Store
	hub        *hub.Hub
	limiter    *auth.Limiter
	subSvc     *subpage.Service
	subIndex   *subpage.Index
	subLimiter *subpage.RateLimiter
	version    string

	svcMgr         host.ServiceManager
	logSrc         host.LogSource
	logStreams     *logStreamRegistry
	privilegesMode string
	// runner and telemtServiceName back POST /api/telemt/restart — the same
	// Runner/service-name resolution the update engine uses for its own
	// restart-after-install step (see New's telemtServiceName comment
	// below), reused here for an admin-triggered restart with no update
	// attached.
	runner            host.Runner
	telemtServiceName string
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
	autoUpdater  *update.AutoUpdater

	// webUI serves the embedded SPA (internal/webui) — registered as the
	// mux's catch-all "/" pattern in Handler(), after every /api/ and
	// /sub/ route, so it never shadows them. nil only if the embedded
	// dist/ somehow fails to read (see webui.New's doc comment: this is
	// effectively unreachable in practice), in which case Handler serves
	// the API/subpage surface with no SPA behind it rather than panicking.
	webUI http.Handler
}

// New builds the handler tree.
func New(cfg *config.Config, tc *telemt.Client, st store.Store, hb *hub.Hub, version string) *Server {
	probe := host.DefaultProbe()
	svcMgr := host.NewServiceManager(cfg.Host.ServiceManager, probe, host.OSCmdRunner)
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
		BinaryPaths: []string{
			cfg.Updates.TelemtBinaryPath, cfg.Updates.TelemtBinaryPath + ".bak",
			cfg.Updates.PanelBinaryPath, cfg.Updates.PanelBinaryPath + ".bak",
		},
		StagingPrefix: stagingPrefix(cfg.DataDir),
		Services:      allowedServiceNames(cfg.Host),
	}
	runner := host.SelectRunner(cfg.Privileges.Mode, cfg.Privileges.AgentSocket, euid, allow, svcMgr, logSrc)
	privilegesMode := host.ResolveMode(cfg.Privileges.Mode, cfg.Privileges.AgentSocket, euid)

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
		Runner:      runner,
		Store:       st,
		Targets:     map[string]update.Target{update.TargetTelemt: telemtTarget, update.TargetPanel: panelTarget},
		StagingDir:  allow.StagingPrefix,
		GithubToken: cfg.Updates.GithubToken,
		Hub:         hb,
	})

	webUI, err := webui.New(webui.Embedded(), cfg.BasePath)
	if err != nil {
		// See the webUI field's doc comment — unreachable outside a
		// corrupted embed, logged rather than fatal so the API/subpage
		// surface still comes up.
		slog.Error("build webui handler", "err", err)
	}

	return &Server{
		cfg:                cfg,
		tc:                 tc,
		st:                 st,
		hub:                hb,
		limiter:            auth.NewLimiter(),
		subSvc:             subpage.NewService(cfg.Subpage.Secret, cfg.BasePath, st),
		subIndex:           subpage.NewIndex(cfg.Subpage.Secret, tc, st),
		subLimiter:         subpage.NewRateLimiter(),
		version:            version,
		svcMgr:             svcMgr,
		logSrc:             logSrc,
		logStreams:         newLogStreamRegistry(),
		privilegesMode:     privilegesMode,
		logStreamHeartbeat: logStreamHeartbeatInterval,
		updateEngine:       updateEngine,
		autoUpdater:        update.NewAutoUpdater(st, updateEngine),
		runner:             runner,
		telemtServiceName:  telemtServiceName,
		webUI:              webUI,
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
		writeJSON(w, http.StatusOK, map[string]string{
			"status":  "ok",
			"version": s.version,
		})
	})

	// protect wraps a handler with the CSRF and session checks shared by
	// every authenticated /api/* route except /api/auth/login (which has
	// its own checks) and /sub/* (no cookie, no mutations, out of scope
	// here).
	protect := func(h http.HandlerFunc) http.Handler {
		return chain(h, auth.CSRF(s.cfg), auth.RequireSession(s.st, s.cfg))
	}

	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.Handle("POST /api/auth/logout", protect(s.handleLogout))
	mux.Handle("GET /api/auth/me", protect(s.handleMe))
	mux.Handle("GET /api/auth/sessions", protect(s.handleListSessions))
	mux.Handle("DELETE /api/auth/sessions", protect(s.handleRevokeOtherSessions))
	mux.Handle("DELETE /api/auth/sessions/{sessionId}", protect(s.handleRevokeSession))

	mux.Handle("GET /api/telemt/info", protect(s.handleTelemtInfo))
	mux.Handle("GET /api/telemt/config", protect(s.handleGetTelemtConfig))
	mux.Handle("PATCH /api/telemt/config", protect(s.handlePatchTelemtConfig))
	mux.Handle("POST /api/telemt/reload", protect(s.handleTelemtReload))
	mux.Handle("GET /api/telemt/reload/{id}", protect(s.handleTelemtReloadStatus))
	mux.Handle("POST /api/telemt/restart", protect(s.handleTelemtRestart))
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

	mux.Handle("GET /api/updates", protect(s.handleGetUpdates))
	mux.Handle("POST /api/updates/{target}/apply", protect(s.handleApplyUpdate))
	mux.Handle("GET /api/updates/auto", protect(s.handleGetAutoUpdate))
	mux.Handle("PUT /api/updates/auto", protect(s.handlePutAutoUpdate))

	mux.Handle("GET /api/events", protect(s.handleEvents))
	mux.Handle("GET /api/events/logs", protect(s.handleEventsLogs))
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

	// subpage.enabled=false removes the route entirely rather than
	// registering it and 404ing — an operator that disabled the module
	// gets a plain unrouted path, not a page that pretends to check
	// tokens.
	if s.cfg.Subpage.Enabled {
		mux.Handle("GET /sub/{token}", s.subpageRateLimited(s.handleSubpage))
	}

	apiHandler := apiJSONFallback(mux)
	if s.webUI == nil {
		return apiHandler
	}
	// The embedded SPA (internal/webui) sits behind this mux, not
	// registered as a "/" pattern on it directly: ServeMux's own
	// most-specific-match algorithm can't tell "no /api/ route matches
	// this path" apart from "the catch-all matched" once a catch-all
	// exists on the same mux — that would swallow apiJSONFallback's
	// pattern=="" 404/405 detection for /api/* and the subpage's own
	// 404/405 for /sub/*. spaRouter (below) dispatches by namespace
	// prefix instead (/api, /sub, everything else) so both keep exactly
	// their own behavior and webUI only ever sees a path neither owns.
	return &spaRouter{mux: mux, api: apiHandler, webUI: s.webUI}
}

// spaRouter is Handler()'s top-level dispatcher once the embedded SPA is
// available: exactly three namespaces, checked in order.
//
//   - /api and everything under /api/ always go through api
//     (apiJSONFallback's JSON {code,message} 404/405 for an unmatched
//     route, unchanged from pre-M3 other than fix round 1's finding 5:
//     a bare "/api" now gets the same treatment as "/api/nope").
//   - /sub and everything under /sub/ always go straight to mux, regardless
//     of method or whether a pattern actually matches — never to webUI.
//     This means mux's own behavior applies unconditionally: the subpage
//     handler's plain-text 404 for an unknown token, its own 405 for a
//     non-GET request (fix round 1, finding 4 — the earlier version of
//     this router let a wrong-method /sub/{token} fall through to webUI's
//     generic 405 instead), and a bare "/sub" 404 (finding 5); or, when
//     subpage.enabled is false and no /sub/{token} pattern is registered
//     at all, ServeMux's own plain-text 404 — the exact pre-M3 behavior,
//     with no special-casing needed since webUI is never consulted for
//     this prefix either way.
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
	// The auto-updater is the one goroutine this method owns directly
	// (everything else lives behind s.hub/s.logStreams' own Close). It
	// already selects on ctx.Done() every loop iteration, so canceling ctx
	// stops it immediately rather than after its next tick interval; wg.Wait
	// (deferred first, so it runs last — defers are LIFO) blocks Run's
	// return until that goroutine has actually exited.
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		s.autoUpdater.Run(ctx)
	}()
	defer wg.Wait()

	defer s.limiter.Stop()
	defer s.subLimiter.Stop()
	defer s.hub.Close()
	defer s.logStreams.Close()

	srv := &http.Server{
		Addr:         s.cfg.Listen,
		Handler:      s.Handler(),
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}
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

	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()
	slog.Info("panel listening", "addr", s.cfg.Listen)

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		slog.Info("shutdown signal received, draining connections")
		// Visibility only, never a wait: an in-flight install/restart must
		// not block shutdown (SIGTERM has to work even mid-update, and a
		// panel self-update restarts this very process by design). The
		// run's own correctness on an interrupted shutdown comes from
		// ReconcileStartup at the next boot, not from anything done here.
		if s.updateEngine.HasActiveRun() {
			slog.Warn("update in progress at shutdown; will reconcile on next boot")
		}
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			return err
		}
		<-errCh
		slog.Info("shutdown complete")
		return nil
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("encode response", "err", err)
	}
}
