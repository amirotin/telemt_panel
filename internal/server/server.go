package server

import (
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/acme/autocert"

	"github.com/telemt/telemt-panel/internal/auth"
	"github.com/telemt/telemt-panel/internal/auto_update"
	"github.com/telemt/telemt-panel/internal/config"
	"github.com/telemt/telemt-panel/internal/geoip"
	"github.com/telemt/telemt-panel/internal/logs"
	"github.com/telemt/telemt-panel/internal/panel_updater"
	"github.com/telemt/telemt-panel/internal/proxy"
	"github.com/telemt/telemt-panel/internal/spa"
	"github.com/telemt/telemt-panel/internal/telemt_config"
	"github.com/telemt/telemt-panel/internal/updater"
	"github.com/telemt/telemt-panel/internal/ws"
)

// loginRateLimiter tracks failed login attempts per IP.
type loginRateLimiter struct {
	mu       sync.Mutex
	attempts map[string][]time.Time
}

func newLoginRateLimiter() *loginRateLimiter {
	rl := &loginRateLimiter{attempts: make(map[string][]time.Time)}
	go rl.cleanup()
	return rl
}

// cleanup periodically removes stale entries to prevent unbounded memory growth.
func (rl *loginRateLimiter) cleanup() {
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		rl.mu.Lock()
		now := time.Now()
		for ip, times := range rl.attempts {
			valid := times[:0]
			for _, t := range times {
				if now.Sub(t) < 5*time.Minute {
					valid = append(valid, t)
				}
			}
			if len(valid) == 0 {
				delete(rl.attempts, ip)
			} else {
				rl.attempts[ip] = valid
			}
		}
		rl.mu.Unlock()
	}
}

// allow returns true if the IP has fewer than maxAttempts in the given window.
func (rl *loginRateLimiter) allow(ip string, maxAttempts int, window time.Duration) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-window)

	// Remove expired entries
	valid := rl.attempts[ip][:0]
	for _, t := range rl.attempts[ip] {
		if t.After(cutoff) {
			valid = append(valid, t)
		}
	}
	rl.attempts[ip] = valid

	return len(valid) < maxAttempts
}

// record adds a failed attempt for the IP.
func (rl *loginRateLimiter) record(ip string) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	rl.attempts[ip] = append(rl.attempts[ip], time.Now())
}

type Server struct {
	cfg *config.Config
}

func New(cfg *config.Config) *Server {
	return &Server{cfg: cfg}
}

type jsonResponse struct {
	OK   bool        `json:"ok"`
	Data interface{} `json:"data,omitempty"`
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("json encode error: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok": false,
		"error": map[string]string{
			"code":    code,
			"message": message,
		},
	})
}

func (s *Server) Run(version string, distFS fs.FS) error {
	jwtSecret := []byte(s.cfg.Auth.JWTSecret)

	ttl, err := time.ParseDuration(s.cfg.Auth.SessionTTL)
	if err != nil {
		ttl = 24 * time.Hour
	}

	telemtProxy, err := proxy.NewTelemtProxy(s.cfg.Telemt.URL, s.cfg.Telemt.AuthHeader)
	if err != nil {
		return err
	}

	limiter := newLoginRateLimiter()
	mux := http.NewServeMux()

	// Auth endpoints
	mux.HandleFunc("POST /api/auth/login", func(w http.ResponseWriter, r *http.Request) {
		ip := r.RemoteAddr
		// Strip port from RemoteAddr (e.g. "1.2.3.4:12345" → "1.2.3.4")
		if host, _, ok := strings.Cut(ip, ":"); ok {
			ip = host
		}
		// Use only the first (leftmost, client) IP from X-Forwarded-For
		if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
			if first, _, _ := strings.Cut(fwd, ","); first != "" {
				ip = strings.TrimSpace(first)
			}
		}

		if !limiter.allow(ip, 5, 1*time.Minute) {
			writeError(w, http.StatusTooManyRequests, "rate_limited", "too many login attempts, try again later")
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1 MB limit
		var req loginRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "bad_request", "invalid request body")
			return
		}

		if req.Username != s.cfg.Auth.Username || !auth.CheckPassword(req.Password, s.cfg.Auth.PasswordHash) {
			limiter.record(ip)
			writeError(w, http.StatusUnauthorized, "unauthorized", "invalid credentials")
			return
		}

		token, err := auth.GenerateToken(req.Username, jwtSecret, ttl)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error", "failed to generate token")
			return
		}

		cookiePath := "/"
		if s.cfg.BasePath != "" {
			cookiePath = s.cfg.BasePath + "/"
		}
		http.SetCookie(w, &http.Cookie{
			Name:     "session",
			Value:    token,
			Path:     cookiePath,
			MaxAge:   int(ttl.Seconds()),
			HttpOnly: true,
			SameSite: http.SameSiteStrictMode,
			Secure:   r.TLS != nil,
		})

		writeJSON(w, http.StatusOK, jsonResponse{
			OK:   true,
			Data: map[string]string{"username": req.Username},
		})
	})

	mux.HandleFunc("POST /api/auth/logout", func(w http.ResponseWriter, r *http.Request) {
		cookiePath := "/"
		if s.cfg.BasePath != "" {
			cookiePath = s.cfg.BasePath + "/"
		}
		http.SetCookie(w, &http.Cookie{
			Name:     "session",
			Value:    "",
			Path:     cookiePath,
			MaxAge:   -1,
			HttpOnly: true,
			SameSite: http.SameSiteStrictMode,
		})
		writeJSON(w, http.StatusOK, jsonResponse{OK: true})
	})

	mux.Handle("GET /api/auth/me", auth.RequireAuth(jwtSecret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, jsonResponse{
			OK:   true,
			Data: map[string]string{"username": r.Header.Get("X-Auth-User")},
		})
	})))

	// User defaults endpoint
	mux.Handle("GET /api/users/defaults", auth.RequireAuth(jwtSecret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, jsonResponse{OK: true, Data: s.cfg.Users})
	})))

	// WebSocket endpoint (auth checked via cookie on upgrade)
	wsHandler := ws.NewHandler(s.cfg.Telemt.URL, s.cfg.Telemt.AuthHeader)
	mux.Handle("/api/ws", auth.RequireAuth(jwtSecret, wsHandler))

	// Update endpoints
	upd := updater.New(
		s.cfg.Telemt.URL,
		s.cfg.Telemt.BinaryPath,
		s.cfg.Telemt.ServiceName,
		s.cfg.Telemt.GithubRepo,
		s.cfg.Telemt.AuthHeader,
		s.cfg.DataDir,
		s.cfg.Panel.MaxNewerReleases,
		s.cfg.Panel.MaxOlderReleases,
	)

	mux.Handle("GET /api/update/check", auth.RequireAuth(jwtSecret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		result, err := upd.Check()
		if err != nil {
			writeError(w, http.StatusBadGateway, "update_check_failed", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, jsonResponse{OK: true, Data: result})
	})))

	mux.Handle("GET /api/update/releases", auth.RequireAuth(jwtSecret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		result, err := upd.Releases()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "RELEASES_ERROR", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, jsonResponse{OK: true, Data: result})
	})))

	mux.Handle("POST /api/update/apply", auth.RequireAuth(jwtSecret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Version string `json:"version"`
		}
		// Body is optional — ignore decode errors for backward compat
		_ = json.NewDecoder(r.Body).Decode(&req)

		if err := upd.Apply(req.Version); err != nil {
			writeError(w, http.StatusConflict, "UPDATE_IN_PROGRESS", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, jsonResponse{OK: true, Data: upd.GetStatus()})
	})))

	mux.Handle("GET /api/update/status", auth.RequireAuth(jwtSecret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, jsonResponse{OK: true, Data: upd.GetStatus()})
	})))

	// Panel update endpoints
	panelUpd := panel_updater.New(
		version,
		s.cfg.Panel.BinaryPath,
		s.cfg.Panel.ServiceName,
		s.cfg.Panel.GithubRepo,
		s.cfg.DataDir,
		s.cfg.Panel.MaxNewerReleases,
		s.cfg.Panel.MaxOlderReleases,
	)

	mux.Handle("GET /api/panel/update/check", auth.RequireAuth(jwtSecret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		result, err := panelUpd.Check()
		if err != nil {
			writeError(w, http.StatusBadGateway, "update_check_failed", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, jsonResponse{OK: true, Data: result})
	})))

	mux.Handle("GET /api/panel/update/releases", auth.RequireAuth(jwtSecret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		result, err := panelUpd.Releases()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "RELEASES_ERROR", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, jsonResponse{OK: true, Data: result})
	})))

	mux.Handle("POST /api/panel/update/apply", auth.RequireAuth(jwtSecret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Version string `json:"version"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)

		if err := panelUpd.Apply(req.Version); err != nil {
			writeError(w, http.StatusConflict, "UPDATE_IN_PROGRESS", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, jsonResponse{OK: true, Data: panelUpd.GetStatus()})
	})))

	mux.Handle("GET /api/panel/update/status", auth.RequireAuth(jwtSecret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, jsonResponse{OK: true, Data: panelUpd.GetStatus()})
	})))

	// Auto-update manager
	autoMgr := auto_update.New()
	autoMgr.Register("panel", auto_update.Component{
		CheckFn: func() (*auto_update.CheckResult, error) {
			r, err := panelUpd.Check()
			if err != nil {
				return nil, err
			}
			return &auto_update.CheckResult{
				CurrentVersion:  r.CurrentVersion,
				LatestVersion:   r.LatestVersion,
				UpdateAvailable: r.UpdateAvailable,
				ReleaseName:     r.ReleaseName,
				ReleaseURL:      r.ReleaseURL,
				PublishedAt:     r.PublishedAt,
				Changelog:       r.Changelog,
			}, nil
		},
		ApplyFn: func(version string) error { return panelUpd.Apply(version) },
	}, auto_update.ComponentConfig{
		Enabled:       s.cfg.Panel.AutoUpdate.Enabled,
		CheckInterval: s.cfg.Panel.AutoUpdate.CheckInterval,
		AutoApply:     s.cfg.Panel.AutoUpdate.AutoApply,
	})
	autoMgr.Register("telemt", auto_update.Component{
		CheckFn: func() (*auto_update.CheckResult, error) {
			r, err := upd.Check()
			if err != nil {
				return nil, err
			}
			return &auto_update.CheckResult{
				CurrentVersion:  r.CurrentVersion,
				LatestVersion:   r.LatestVersion,
				UpdateAvailable: r.UpdateAvailable,
				ReleaseName:     r.ReleaseName,
				ReleaseURL:      r.ReleaseURL,
				PublishedAt:     r.PublishedAt,
				Changelog:       r.Changelog,
			}, nil
		},
		ApplyFn: func(version string) error { return upd.Apply(version) },
	}, auto_update.ComponentConfig{
		Enabled:       s.cfg.Telemt.AutoUpdate.Enabled,
		CheckInterval: s.cfg.Telemt.AutoUpdate.CheckInterval,
		AutoApply:     s.cfg.Telemt.AutoUpdate.AutoApply,
	})
	defer autoMgr.StopAll()

	// Auto-update API
	mux.Handle("GET /api/auto-update/status", auth.RequireAuth(jwtSecret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, jsonResponse{OK: true, Data: autoMgr.GetStatus()})
	})))
	mux.Handle("PUT /api/auto-update/config", auth.RequireAuth(jwtSecret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req auto_update.UpdateConfigRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "bad_request", "invalid request body")
			return
		}
		autoMgr.UpdateConfig("panel", req.Panel)
		autoMgr.UpdateConfig("telemt", req.Telemt)

		// Persist auto-update settings to config file
		if s.cfg.Path != "" {
			updates := map[string]interface{}{
				"panel.auto_update.enabled":         req.Panel.Enabled,
				"panel.auto_update.check_interval":  req.Panel.CheckInterval,
				"panel.auto_update.auto_apply":      req.Panel.AutoApply,
				"telemt.auto_update.enabled":        req.Telemt.Enabled,
				"telemt.auto_update.check_interval": req.Telemt.CheckInterval,
				"telemt.auto_update.auto_apply":     req.Telemt.AutoApply,
			}
			if _, err := telemt_config.QuickUpdate(s.cfg.Path, updates); err != nil {
				log.Printf("WARNING: failed to persist auto-update config: %s", err)
			}
		}

		writeJSON(w, http.StatusOK, jsonResponse{OK: true, Data: autoMgr.GetStatus()})
	})))

	// Telemt service restart endpoint
	mux.Handle("POST /api/telemt/restart", auth.RequireAuth(jwtSecret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := updater.RestartService(s.cfg.Telemt.ServiceName); err != nil {
			writeError(w, http.StatusInternalServerError, "restart_failed", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, jsonResponse{OK: true, Data: map[string]string{"status": "restarting"}})
	})))

	// Helper: resolve Telemt config path from panel config or Telemt API
	getTelemtConfigPath := func(w http.ResponseWriter) (string, bool) {
		if s.cfg.Telemt.ConfigPath != "" {
			return s.cfg.Telemt.ConfigPath, true
		}
		systemInfo, err := telemtProxy.GetSystemInfo()
		if err != nil {
			writeError(w, http.StatusBadGateway, "telemt_api_error", err.Error())
			return "", false
		}
		return systemInfo.ConfigPath, true
	}

	// Telemt config endpoints
	mux.Handle("GET /api/telemt/config/raw", auth.RequireAuth(jwtSecret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		configPath, ok := getTelemtConfigPath(w)
		if !ok {
			return
		}

		content, hash, err := telemt_config.ReadConfig(configPath)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "read_config_failed", err.Error())
			return
		}

		writeJSON(w, http.StatusOK, jsonResponse{
			OK: true,
			Data: map[string]string{
				"content": content,
				"path":    configPath,
				"hash":    hash,
			},
		})
	})))

	mux.Handle("POST /api/telemt/config/save", auth.RequireAuth(jwtSecret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Content string `json:"content"`
			Restart bool   `json:"restart"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "bad_request", "invalid request body")
			return
		}

		configPath, ok := getTelemtConfigPath(w)
		if !ok {
			return
		}

		// Save config
		newHash, err := telemt_config.SaveConfig(configPath, req.Content)
		if err != nil {
			writeError(w, http.StatusBadRequest, "save_failed", err.Error())
			return
		}

		// Restart if requested
		if req.Restart {
			if err := updater.RestartService(s.cfg.Telemt.ServiceName); err != nil {
				writeError(w, http.StatusInternalServerError, "restart_failed", err.Error())
				return
			}
		}

		writeJSON(w, http.StatusOK, jsonResponse{
			OK: true,
			Data: map[string]interface{}{
				"success":  true,
				"new_hash": newHash,
			},
		})
	})))

	mux.Handle("POST /api/telemt/config/quick-update", auth.RequireAuth(jwtSecret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Updates map[string]interface{} `json:"updates"`
			Restart bool                   `json:"restart"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "bad_request", "invalid request body")
			return
		}

		configPath, ok := getTelemtConfigPath(w)
		if !ok {
			return
		}

		// Quick update
		newHash, err := telemt_config.QuickUpdate(configPath, req.Updates)
		if err != nil {
			writeError(w, http.StatusBadRequest, "update_failed", err.Error())
			return
		}

		// Restart if requested
		if req.Restart {
			if err := updater.RestartService(s.cfg.Telemt.ServiceName); err != nil {
				writeError(w, http.StatusInternalServerError, "restart_failed", err.Error())
				return
			}
		}

		writeJSON(w, http.StatusOK, jsonResponse{
			OK: true,
			Data: map[string]interface{}{
				"success":  true,
				"new_hash": newHash,
			},
		})
	})))

	// GeoIP lookup endpoint
	var geoipLookup *geoip.Lookup
	if s.cfg.GeoIP.DBPath != "" {
		log.Printf("GeoIP: loading city database from %s", s.cfg.GeoIP.DBPath)
		if s.cfg.GeoIP.ASNDBPath != "" {
			log.Printf("GeoIP: loading ASN database from %s", s.cfg.GeoIP.ASNDBPath)
		}
		var geoErr error
		geoipLookup, geoErr = geoip.New(s.cfg.GeoIP.DBPath, s.cfg.GeoIP.ASNDBPath)
		if geoErr != nil {
			log.Printf("WARNING: failed to open GeoIP database: %s (check that db_path and asn_db_path point to valid .mmdb files)", geoErr)
		} else {
			log.Printf("GeoIP: databases loaded successfully")
			defer func() { _ = geoipLookup.Close() }()
		}
	}

	mux.Handle("POST /api/geoip/lookup", auth.RequireAuth(jwtSecret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if geoipLookup == nil {
			writeError(w, http.StatusServiceUnavailable, "geoip_disabled", "GeoIP database is not configured")
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		var req struct {
			IPs []string `json:"ips"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "bad_request", "invalid request body")
			return
		}

		if len(req.IPs) > 2000 {
			writeError(w, http.StatusBadRequest, "too_many_ips", "maximum 2000 IPs per request")
			return
		}

		results := geoipLookup.LookupIPs(req.IPs)
		writeJSON(w, http.StatusOK, jsonResponse{OK: true, Data: results})
	})))

	// Logs
	logStatus := logs.CheckStatus(s.cfg.Telemt.ServiceName, s.cfg.Telemt.ContainerName)
	var logsWsHandler http.Handler
	if logStatus.Available {
		logSource, err := logs.DetectSource(s.cfg.Telemt.ServiceName, s.cfg.Telemt.ContainerName)
		if err != nil {
			log.Printf("WARN: log source init failed: %v", err)
		} else {
			logsWsHandler = logs.NewWsHandler(logSource, 2)
			log.Printf("Log source: %s (%s)", logSource.Name(), logStatus.Target)
		}
	}

	// Log status endpoint — always registered (frontend needs it to show unavailable state)
	mux.Handle("GET /api/logs/status", auth.RequireAuth(jwtSecret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, jsonResponse{OK: true, Data: logStatus})
	})))

	// Log WebSocket — only if source is available
	if logsWsHandler != nil {
		mux.Handle("/api/ws/logs", auth.RequireAuth(jwtSecret, logsWsHandler))
	}

	// Telemt connectivity check (diagnostic endpoint)
	mux.Handle("GET /api/telemt/connectivity", auth.RequireAuth(jwtSecret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		result := telemtProxy.ConnectivityCheck()
		writeJSON(w, http.StatusOK, jsonResponse{OK: true, Data: result})
	})))

	// Telemt API proxy (kept for direct REST calls like user CRUD)
	mux.Handle("/api/telemt/", auth.RequireAuth(jwtSecret, telemtProxy))

	// SPA
	mux.Handle("/", spa.NewHandler(distFS, s.cfg.BasePath))

	// Build handler chain: securityHeaders → basePathHandler (if needed) → mux
	var handler http.Handler = mux
	if s.cfg.BasePath != "" {
		handler = basePathHandler(s.cfg.BasePath, mux)
	}
	handler = securityHeaders(handler)

	srv := &http.Server{
		Addr:         s.cfg.Listen,
		Handler:      handler,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// TLS: ACME (Let's Encrypt)
	if s.cfg.TLS.AcmeDomain != "" {
		manager := &autocert.Manager{
			Cache:      autocert.DirCache(s.cfg.TLS.AcmeCacheDir),
			Prompt:     autocert.AcceptTOS,
			HostPolicy: autocert.HostWhitelist(s.cfg.TLS.AcmeDomain),
		}
		srv.TLSConfig = manager.TLSConfig()

		// HTTP->HTTPS redirect on port 80
		go func() {
			log.Printf("Telemt Panel HTTP->HTTPS redirect on :80")
			if err := http.ListenAndServe(":80", manager.HTTPHandler(nil)); err != nil {
				log.Printf("HTTP redirect server error: %s", err)
			}
		}()

		log.Printf("Telemt Panel listening on %s (ACME TLS, domain: %s)", s.cfg.Listen, s.cfg.TLS.AcmeDomain)
		return srv.ListenAndServeTLS("", "")
	}

	// TLS: custom certificates
	if s.cfg.TLS.CertFile != "" {
		log.Printf("Telemt Panel listening on %s (TLS)", s.cfg.Listen)
		return srv.ListenAndServeTLS(s.cfg.TLS.CertFile, s.cfg.TLS.KeyFile)
	}

	// Plain HTTP
	log.Printf("Telemt Panel listening on %s", s.cfg.Listen)
	return srv.ListenAndServe()
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		if r.TLS != nil {
			w.Header().Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}

// basePathHandler strips the base path prefix from incoming requests.
// GET /{basePath} → 301 redirect to /{basePath}/
// /{basePath}/... → strip prefix, pass to next handler
// anything else → 404
func basePathHandler(basePath string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Exact match without trailing slash → redirect
		if r.URL.Path == basePath {
			http.Redirect(w, r, basePath+"/", http.StatusMovedPermanently)
			return
		}

		prefix := basePath + "/"
		if !strings.HasPrefix(r.URL.Path, prefix) {
			http.NotFound(w, r)
			return
		}

		// Strip base path, keep leading slash
		r.URL.Path = "/" + strings.TrimPrefix(r.URL.Path, prefix)
		r.URL.RawPath = ""
		next.ServeHTTP(w, r)
	})
}
