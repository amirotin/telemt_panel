package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/host"
	"github.com/amirotin/telemt_panel/internal/paneltls"
)

type tlsPrepared struct {
	Receipt      string                    `json:"receipt"`
	ExpiresAt    time.Time                 `json:"expires_at"`
	Candidate    config.TLSCandidate       `json:"candidate"`
	NewURL       string                    `json:"new_url"`
	Warnings     []string                  `json:"warnings"`
	Certificate  *paneltls.CertificateInfo `json:"certificate,omitempty"`
	revision     [32]byte
	subscription bool
}

type tlsCapabilities struct {
	ConfigWritable bool `json:"config_writable"`
	Restart        bool `json:"restart"`
	Prepare        bool `json:"prepare"`
	ACMEPrepare    bool `json:"acme_prepare"`
}

type tlsSettings struct {
	Active               config.TLSCandidate  `json:"active"`
	Configured           *config.TLSCandidate `json:"configured,omitempty"`
	Capabilities         tlsCapabilities      `json:"capabilities"`
	ManualHints          []string             `json:"manual_hints"`
	DefaultACMECacheDir  string               `json:"default_acme_cache_dir"`
	ConfigPath           string               `json:"config_path,omitempty"`
	ManualRestartCommand string               `json:"manual_restart_command"`
	State                string               `json:"state"`
	Prepared             *tlsPrepared         `json:"prepared,omitempty"`
	RestartRequired      bool                 `json:"restart_required"`
	NewURL               string               `json:"new_url,omitempty"`
	Error                string               `json:"error,omitempty"`
	CertificateStatus    paneltls.Status      `json:"certificate_status"`
}

type panelAccess struct {
	mu                sync.Mutex
	file              *config.TLSFile
	path              string
	ctx               context.Context
	cancel            context.CancelFunc
	mux               *paneltls.ChallengeMux
	run               paneltls.AcquisitionRunner
	state             string
	pending           *tlsPrepared
	saved             bool
	savedRevision     [32]byte
	newURL            string
	err               string
	savedSubscription bool
}

func newPanelAccess() *panelAccess {
	ctx, cancel := context.WithCancel(context.Background())
	return &panelAccess{ctx: ctx, cancel: cancel, state: "idle"}
}

func (a *panelAccess) close() {
	a.cancel()
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.file != nil {
		_ = a.file.Close()
		a.file = nil
	}
}

// SetTLSConfigPath explicitly enables editing only the startup configuration.
// Call once before Run/Handler. An unavailable path leaves a manual-only API.
func (s *Server) SetTLSConfigPath(path string) {
	a := s.access
	a.path = path
	a.file, _ = config.OpenTLSFile(path)
}

func (s *Server) tlsRestartAvailable() bool {
	name, _ := resolveLogicalService("panel", s.svcMgr.Kind(), s.cfg.Host)
	caps := s.svcMgr.Caps()
	if name == "" || s.runner == nil || !caps.CanRestart || s.privilegesMode == host.PrivilegesModeManual {
		return false
	}
	// A service manager installed on the host does not make a manually started
	// panel restartable. Verify the configured service before allowing a handoff.
	if caps.CanStatus {
		ctx, cancel := context.WithTimeout(s.access.ctx, 2*time.Second)
		defer cancel()
		status, err := s.svcMgr.Status(ctx, name)
		return err == nil && status == host.StatusRunning
	}
	return true
}

func (s *Server) tlsCapabilitiesLocked() (tlsCapabilities, []string) {
	a := s.access
	caps := tlsCapabilities{Restart: s.tlsRestartAvailable()}
	hints := []string{}
	if a.file != nil {
		caps.ConfigWritable = a.file.Writable() == nil
	}
	if !caps.ConfigWritable {
		hints = append(hints, "edit_startup_config_manually")
	}
	if !caps.Restart {
		hints = append(hints, "restart_panel_manually")
	}
	caps.Prepare = caps.ConfigWritable
	// Bind permission and port ownership are checked before contacting the CA.
	// This capability only promises the helper is installed, not public reachability.
	_, err := os.Executable()
	caps.ACMEPrepare = caps.Prepare && err == nil
	return caps, hints
}

func (s *Server) defaultTLSCacheLocked() string {
	if s.cfg.TLS.AcmeCacheDir != "" {
		return s.cfg.TLS.AcmeCacheDir
	}
	if s.access.path == "" {
		return ""
	}
	abs, err := filepath.Abs(s.access.path)
	if err != nil {
		return ""
	}
	return filepath.Join(filepath.Dir(abs), "certs")
}

func (s *Server) handleGetTLSConfig(w http.ResponseWriter, r *http.Request) {
	subscription, ok := accessTarget(w, r)
	if !ok {
		return
	}
	a := s.access
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.pending != nil && time.Now().After(a.pending.ExpiresAt) {
		a.pending = nil
		a.state = "idle"
	}
	caps, hints := s.tlsCapabilitiesLocked()
	state := tlsSettings{Active: accessCandidate(s.cfg, subscription), Capabilities: caps, ManualHints: hints, DefaultACMECacheDir: s.accessCache(subscription), State: a.state, RestartRequired: a.saved, NewURL: a.newURL, Error: a.err}
	state.CertificateStatus = s.tlsManager.Status()
	if a.saved && a.savedSubscription != subscription {
		state.NewURL = ""
	}
	if subscription {
		state.CertificateStatus = s.subTLSManager.Status()
	}
	if a.pending != nil && a.pending.subscription == subscription {
		state.Prepared = a.pending
	}
	state.ConfigPath = a.path
	service, _ := resolveLogicalService("panel", s.svcMgr.Kind(), s.cfg.Host)
	state.ManualRestartCommand = manualRestartCommand(s.svcMgr.Kind(), service)
	if state.Active.TLS.Mode == "" {
		state.Active.TLS.Mode = "http"
	}
	if a.file != nil {
		if snapshot, err := a.file.Read(); err == nil {
			configured := accessCandidate(snapshot.Config, subscription)
			state.Configured = &configured
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, state)
}

func decodeTLSBody(w http.ResponseWriter, r *http.Request, value any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		auth.WriteError(w, 400, "bad_request", "invalid transport request body")
		return false
	}
	if decoder.Decode(new(any)) != io.EOF {
		auth.WriteError(w, 400, "bad_request", "one JSON object is required")
		return false
	}
	return true
}

func (s *Server) handlePrepareTLS(w http.ResponseWriter, r *http.Request) {
	subscription, ok := accessTarget(w, r)
	if !ok {
		return
	}
	var request struct {
		config.TLSCandidate
		ConfirmHTTP bool `json:"confirm_http"`
	}
	if !decodeTLSBody(w, r, &request) {
		return
	}
	a := s.access
	a.mu.Lock()
	if a.state == "preparing" || a.saved {
		a.mu.Unlock()
		auth.WriteError(w, 409, "tls_prepare_busy", "a preparation or saved restart is already pending")
		return
	}
	caps, _ := s.tlsCapabilitiesLocked()
	if !caps.Prepare {
		a.mu.Unlock()
		auth.WriteError(w, 503, "tls_manual_required", "configuration write and panel restart privileges are required; apply transport manually")
		return
	}
	candidate := request.TLSCandidate
	peerTLS := s.cfg.TLS
	if !subscription {
		peerTLS = s.cfg.Subpage.TLS
	}
	if candidate.TLS.Mode == "acme" && peerTLS.Mode == "acme" && strings.EqualFold(strings.TrimSuffix(candidate.TLS.AcmeDomain, "."), peerTLS.AcmeDomain) && (candidate.TLS.AcmeCacheDir == "" || candidate.TLS.AcmeCacheDir == s.accessCache(subscription)) {
		candidate.TLS.AcmeCacheDir = peerTLS.AcmeCacheDir
	}
	if err := candidate.Normalize(s.accessCache(subscription)); err != nil {
		a.mu.Unlock()
		auth.WriteError(w, 400, "tls_invalid_candidate", err.Error())
		return
	}
	if (!subscription || candidate.Enabled) && candidate.TLS.Mode == "http" && (!loopbackListen(candidate.Listen) || strings.HasPrefix(candidate.PublicURL, "http://")) && !request.ConfirmHTTP {
		a.mu.Unlock()
		auth.WriteError(w, 400, "confirmation_required", "confirm unencrypted HTTP before preparation")
		return
	}
	snapshot, err := a.file.Read()
	if err != nil {
		a.mu.Unlock()
		auth.WriteError(w, 409, "tls_config_changed", "startup configuration is no longer readable and valid")
		return
	}
	if err := validateAccessCandidate(snapshot.Config, candidate, subscription); err != nil {
		a.mu.Unlock()
		auth.WriteError(w, 400, "tls_invalid_candidate", err.Error())
		return
	}
	a.state = "preparing"
	a.pending = nil
	a.err = ""
	rootCtx, mux, run := a.ctx, a.mux, a.run
	a.mu.Unlock()
	// Override the ordinary 60s write timeout for this route only. Deadline stays
	// bounded even if the browser has a longer-lived HTTP/2 connection.
	controller := http.NewResponseController(w)
	if err := controller.SetWriteDeadline(time.Now().Add(115 * time.Second)); err != nil && !errors.Is(err, http.ErrNotSupported) {
		a.mu.Lock()
		a.state = "idle"
		a.mu.Unlock()
		auth.WriteError(w, 503, "tls_prepare_unavailable", "unable to extend response deadline for certificate preparation")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), paneltls.PrepareTimeout)
	defer cancel()
	stop := context.AfterFunc(rootCtx, cancel)
	defer stop()
	var certificate *paneltls.CertificateInfo
	if !subscription || candidate.Enabled {
		activeListen := s.cfg.Listen
		if subscription {
			activeListen = ""
			if s.cfg.Subpage.Enabled {
				activeListen = s.cfg.Subpage.Listen
			}
		}
		certificate, err = paneltls.PrepareCandidate(ctx, candidate, activeListen, mux, run)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.state = "idle"
	if err != nil {
		var preparation *paneltls.PrepareError
		switch {
		case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
			auth.WriteError(w, 504, "tls_prepare_timeout", "preparation canceled or timed out; current access is unchanged")
		case errors.As(err, &preparation):
			auth.WriteError(w, 422, preparation.Code, preparation.Message)
		default:
			auth.WriteError(w, 422, "tls_prepare_failed", "preparation failed; current access is unchanged")
		}
		return
	}
	if ctx.Err() != nil || a.file == nil {
		auth.WriteError(w, 504, "tls_prepare_timeout", "preparation canceled; current access is unchanged")
		return
	}
	latest, err := a.file.Read()
	if err != nil || latest.Revision != snapshot.Revision {
		auth.WriteError(w, 409, "tls_config_changed", "configuration changed during preparation; prepare again")
		return
	}
	var nonce [32]byte
	_, _ = rand.Read(nonce[:])
	prepared := &tlsPrepared{Receipt: hex.EncodeToString(nonce[:]), ExpiresAt: time.Now().Add(5 * time.Minute), Candidate: candidate, Certificate: certificate, NewURL: s.tlsNewURL(r, candidate, certificate), Warnings: s.tlsWarnings(candidate, certificate, subscription), revision: snapshot.Revision, subscription: subscription}
	a.pending = prepared
	a.state = "prepared"
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, prepared)
}

func loopbackListen(listen string) bool {
	h, _, err := net.SplitHostPort(listen)
	if err != nil {
		return false
	}
	return h == "localhost" || net.ParseIP(h) != nil && net.ParseIP(h).IsLoopback()
}

func (s *Server) tlsWarnings(c config.TLSCandidate, cert *paneltls.CertificateInfo, subscription bool) []string {
	warnings := []string{"toml_formatting"}
	if subscription && !c.Enabled {
		return warnings
	}
	warnings = append(warnings, "public_reachability_unverified")
	activeListen := s.cfg.Listen
	if subscription {
		activeListen = s.cfg.Subpage.Listen
	} else {
		warnings = append(warnings, "password_login")
	}
	_, oldPort, _ := net.SplitHostPort(activeListen)
	_, newPort, _ := net.SplitHostPort(c.Listen)
	if oldPort != newPort {
		warnings = append(warnings, "firewall_port")
	}
	if c.TLS.Mode == "acme" {
		warnings = append(warnings, "acme_port_80")
	}
	if c.TLS.Mode == "http" {
		warnings = append(warnings, "http_unencrypted")
	}
	if cert != nil && !cert.PubliclyTrusted {
		warnings = append(warnings, "certificate_private")
	}
	return warnings
}

func (s *Server) tlsNewURL(r *http.Request, c config.TLSCandidate, cert *paneltls.CertificateInfo) string {
	if c.PublicURL != "" {
		return c.PublicURL + c.BasePath + "/"
	}
	h, port, _ := net.SplitHostPort(c.Listen)
	scheme := "http"
	if c.TLS.Mode != "http" {
		scheme = "https"
	}
	if c.TLS.AcmeDomain != "" {
		h = c.TLS.AcmeDomain
	} else if cert != nil && cert.Domain != "" && !strings.Contains(cert.Domain, "*") {
		h = cert.Domain
	}
	if h == "" || net.ParseIP(h) != nil && net.ParseIP(h).IsUnspecified() {
		h = r.Host
		if host, _, err := net.SplitHostPort(h); err == nil {
			h = host
		}
		probe := config.TLSCandidate{Listen: net.JoinHostPort(h, port), TLS: config.TLSConfig{Mode: "http"}}
		if probe.Normalize("") != nil {
			h = "localhost"
		}
	}
	u := url.URL{Scheme: scheme, Host: net.JoinHostPort(h, port), Path: c.BasePath + "/"}
	return u.String()
}

func (s *Server) handlePutTLSConfig(w http.ResponseWriter, r *http.Request) {
	subscription, ok := accessTarget(w, r)
	if !ok {
		return
	}
	var request struct {
		Receipt   string              `json:"receipt"`
		Candidate config.TLSCandidate `json:"candidate"`
	}
	if !decodeTLSBody(w, r, &request) {
		return
	}
	a := s.access
	a.mu.Lock()
	defer a.mu.Unlock()
	p := a.pending
	if p == nil || p.subscription != subscription || p.Receipt != request.Receipt || time.Now().After(p.ExpiresAt) || request.Candidate != p.Candidate {
		auth.WriteError(w, 409, "tls_receipt_invalid", "prepare this exact candidate again; receipt is stale, changed or already used")
		return
	}
	caps, _ := s.tlsCapabilitiesLocked()
	if !caps.Prepare {
		auth.WriteError(w, 503, "tls_manual_required", "write/restart permissions are unavailable; configuration was not saved")
		return
	}
	if (!subscription || p.Candidate.Enabled) && p.Candidate.TLS.Mode == "certificate" {
		certificate, err := paneltls.PrepareCandidate(r.Context(), p.Candidate, p.Candidate.Listen, nil, nil)
		if err != nil || certificate == nil || p.Certificate == nil || *certificate != *p.Certificate {
			auth.WriteError(w, 422, "tls_certificate_invalid", "prepared certificate/key changed or became unavailable; prepare again")
			return
		}
	}
	if (!subscription || p.Candidate.Enabled) && p.Candidate.TLS.Mode == "acme" {
		if err := paneltls.VerifyPreparedCache(p.Candidate, p.Certificate); err != nil {
			var preparation *paneltls.PrepareError
			if errors.As(err, &preparation) {
				auth.WriteError(w, 422, preparation.Code, preparation.Message)
			} else {
				auth.WriteError(w, 422, "tls_certificate_invalid", "prepared ACME cache is no longer valid; prepare again")
			}
			return
		}
	}
	if err := a.file.SaveAccess(p.revision, p.Candidate, subscription, true); err != nil {
		if errors.Is(err, config.ErrTLSRevision) {
			auth.WriteError(w, 409, "tls_config_changed", "configuration changed after preparation; prepare again")
		} else {
			auth.WriteError(w, 503, "tls_save_failed", "unable to save startup configuration; check file and directory permissions")
		}
		return
	}
	snapshot, err := a.file.Read()
	if err == nil {
		a.savedRevision = snapshot.Revision
	}
	a.saved = true
	a.savedSubscription = subscription
	a.newURL = p.NewURL
	a.pending = nil
	a.state = "saved"
	auditTarget := "panel"
	if subscription {
		auditTarget = "subscription"
	}
	s.appendAudit(r, "panel.tls.save", "", auditTarget+":"+p.Candidate.TLS.Mode)
	writeJSON(w, 200, map[string]any{"new_url": a.newURL, "restart_required": true})
}

func (s *Server) handleRestartTLS(w http.ResponseWriter, r *http.Request) {
	a := s.access
	a.mu.Lock()
	if !a.saved || a.state == "restarting" {
		a.mu.Unlock()
		auth.WriteError(w, 409, "tls_restart_not_pending", "save a prepared transport change before restarting")
		return
	}
	if !s.tlsRestartAvailable() {
		a.mu.Unlock()
		auth.WriteError(w, 503, "tls_manual_required", "restart the panel service manually")
		return
	}
	snapshot, err := a.file.Read()
	if err != nil || snapshot.Revision != a.savedRevision {
		a.mu.Unlock()
		auth.WriteError(w, 409, "tls_config_changed", "saved configuration changed; inspect it and restart manually")
		return
	}
	name, _ := resolveLogicalService("panel", s.svcMgr.Kind(), s.cfg.Host)
	a.state = "restarting"
	a.err = ""
	newURL := a.newURL
	a.mu.Unlock()
	s.appendAudit(r, "panel.tls.restart", "", "")
	writeJSON(w, 202, map[string]any{"new_url": newURL, "restart_required": true})
	if err := http.NewResponseController(w).Flush(); err != nil {
		a.mu.Lock()
		a.state = "restart_failed"
		a.err = "tls_restart_failed"
		a.mu.Unlock()
		return
	}
	// Use the existing allowlisted Runner only after delivering the response.
	go func() {
		ctx, cancel := context.WithTimeout(a.ctx, 30*time.Second)
		defer cancel()
		_, err := s.runner.Run(ctx, host.Op{Kind: host.OpRestartService, Args: map[string]string{host.ArgService: name}})
		a.mu.Lock()
		defer a.mu.Unlock()
		if err != nil {
			a.state = "restart_failed"
			a.err = "tls_restart_failed"
		}
	}()
}
