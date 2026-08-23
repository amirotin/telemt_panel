// Package httpapi wires the panel's HTTP surface. Contract: api/openapi.yaml.
// v1.x convention (differs from 0.x): no {ok,data} envelope — plain status
// codes, success bodies are the resource, errors are {code, message}.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

// Server holds the panel's HTTP dependencies.
type Server struct {
	cfg     *config.Config
	tc      *telemt.Client
	version string
}

// New builds the handler tree.
func New(cfg *config.Config, tc *telemt.Client, version string) *Server {
	return &Server{cfg: cfg, tc: tc, version: version}
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

	mux.HandleFunc("GET /api/telemt/info", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()

		type info struct {
			Reachable bool   `json:"reachable"`
			Version   string `json:"version,omitempty"`
			Hint      string `json:"hint,omitempty"`
		}
		sysInfo, err := s.tc.SystemInfo(ctx)
		if err != nil {
			var apiErr *telemt.APIError
			hint := "telemt is unreachable — check telemt.url"
			if errors.As(err, &apiErr) && apiErr.Status == http.StatusUnauthorized {
				hint = "telemt rejected authorization — check telemt.auth_header"
			}
			writeJSON(w, http.StatusOK, info{Reachable: false, Hint: hint})
			return
		}
		writeJSON(w, http.StatusOK, info{Reachable: true, Version: sysInfo.Version})
	})

	return mux
}

// Run serves until ctx is canceled, then drains connections.
func (s *Server) Run(ctx context.Context) error {
	srv := &http.Server{
		Addr:         s.cfg.Listen,
		Handler:      s.Handler(),
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()
	slog.Info("panel listening", "addr", s.cfg.Listen)

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		slog.Info("shutdown signal received, draining connections")
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
