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
	// logStreamHeartbeat is GET /api/events/logs' heartbeat period; defaults
	// to logStreamHeartbeatInterval (logs_handler.go), overridable by tests
	// in this package the same way svcMgr/logSrc are.
	logStreamHeartbeat time.Duration

	updateEngine *update.Engine
	autoUpdater  *update.AutoUpdater
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
	allow := host.AllowLists{
		BinaryPaths: []string{
			cfg.Updates.TelemtBinaryPath, cfg.Updates.TelemtBinaryPath + ".bak",
			cfg.Updates.PanelBinaryPath, cfg.Updates.PanelBinaryPath + ".bak",
		},
		StagingPrefix: filepath.Join(cfg.DataDir, "staging"),
		Services:      []string{cfg.Host.TelemtService, cfg.Host.PanelService},
	}
	runner := host.SelectRunner(cfg.Privileges.Mode, cfg.Privileges.AgentSocket, euid, allow, svcMgr, logSrc)
	privilegesMode := host.ResolveMode(cfg.Privileges.Mode, cfg.Privileges.AgentSocket, euid)

	telemtTarget := &update.TelemtTarget{
		Client:       tc,
		RepoName:     cfg.Updates.TelemtRepo,
		BinaryPath_:  cfg.Updates.TelemtBinaryPath,
		ServiceName_: cfg.Host.TelemtService,
	}
	panelTarget := &update.PanelTarget{
		Version_:     version,
		RepoName:     cfg.Updates.PanelRepo,
		BinaryPath_:  cfg.Updates.PanelBinaryPath,
		ServiceName_: cfg.Host.PanelService,
	}
	updateEngine := update.NewEngine(update.EngineConfig{
		Runner:      runner,
		Store:       st,
		Targets:     map[string]update.Target{update.TargetTelemt: telemtTarget, update.TargetPanel: panelTarget},
		StagingDir:  allow.StagingPrefix,
		GithubToken: cfg.Updates.GithubToken,
		Hub:         hb,
	})

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
	}
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

	mux.Handle("GET /api/host", protect(s.handleHost))
	mux.Handle("GET /api/logs/tail", protect(s.handleLogsTail))

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

	return mux
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
