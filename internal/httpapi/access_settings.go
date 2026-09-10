package httpapi

import (
	"fmt"
	"net/http"
	"path/filepath"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/config"
)

func accessTarget(w http.ResponseWriter, r *http.Request) (bool, bool) {
	switch r.URL.Query().Get("target") {
	case "", "panel":
		return false, true
	case "subscription":
		return true, true
	default:
		auth.WriteError(w, 400, "bad_request", "unknown access target")
		return false, false
	}
}

func accessCandidate(cfg *config.Config, subscription bool) config.TLSCandidate {
	if !subscription {
		return config.TLSCandidate{Listen: cfg.Listen, TLS: cfg.TLS, BasePath: cfg.BasePath, PublicURL: cfg.PublicURL}
	}
	sub := cfg.Subpage
	if sub.Listen == "" {
		sub.Listen = "127.0.0.1:8081"
	}
	if sub.BasePath == "" {
		sub.BasePath = "/sub"
	}
	if sub.TLS.Mode == "" {
		sub.TLS.Mode = "http"
	}
	return config.TLSCandidate{Listen: sub.Listen, TLS: sub.TLS, BasePath: sub.BasePath, PublicURL: sub.PublicURL, Enabled: sub.Enabled}
}

func (s *Server) accessCache(subscription bool) string {
	if !subscription {
		return s.defaultTLSCacheLocked()
	}
	if s.cfg.Subpage.TLS.AcmeCacheDir != "" {
		return s.cfg.Subpage.TLS.AcmeCacheDir
	}
	cache := s.defaultTLSCacheLocked()
	if cache == "" {
		return ""
	}
	return filepath.Join(cache, "subscription")
}

func validateAccessCandidate(current *config.Config, candidate config.TLSCandidate, subscription bool) error {
	next := *current
	if subscription {
		if candidate.BasePath == "" {
			return fmt.Errorf("subscription base_path must be nonempty")
		}
		next.Subpage.Listen, next.Subpage.TLS = candidate.Listen, candidate.TLS
		next.Subpage.Enabled = candidate.Enabled
		next.Subpage.BasePath, next.Subpage.PublicURL = candidate.BasePath, candidate.PublicURL
	} else {
		next.Listen, next.TLS = candidate.Listen, candidate.TLS
		next.BasePath, next.PublicURL = candidate.BasePath, candidate.PublicURL
	}
	return next.NormalizeAccess()
}
