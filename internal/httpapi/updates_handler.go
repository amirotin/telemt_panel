package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/update"
)

// updatesRequestTimeout bounds GET /api/updates, which fans out to
// GitHub (via the engine's release cache) and Telemt for both targets.
const updatesRequestTimeout = 15 * time.Second

// maxUpdatesRequestBody bounds the apply/auto-settings request bodies —
// generous for their handful of short string fields.
const maxUpdatesRequestBody = 4 << 10

// releaseItemView mirrors one entry of openapi UpdatesStatus.targets[].releases.
type releaseItemView struct {
	Version     string    `json:"version"`
	PublishedAt time.Time `json:"published_at"`
	Prerelease  bool      `json:"prerelease"`
	Newer       bool      `json:"newer"`
}

// updateRunView mirrors openapi UpdateRun.
type updateRunView struct {
	RunID       string     `json:"run_id"`
	Target      string     `json:"target"`
	Phase       string     `json:"phase"`
	VersionFrom string     `json:"version_from,omitempty"`
	VersionTo   string     `json:"version_to"`
	StartedAt   time.Time  `json:"started_at"`
	FinishedAt  *time.Time `json:"finished_at,omitempty"`
	Detail      string     `json:"detail,omitempty"`
}

func runStatusView(s update.RunStatus) updateRunView {
	v := updateRunView{
		RunID: s.RunID, Target: s.Target, Phase: s.Phase,
		VersionFrom: s.VersionFrom, VersionTo: s.VersionTo,
		StartedAt: s.StartedAt, Detail: s.Detail,
	}
	if !s.FinishedAt.IsZero() {
		v.FinishedAt = &s.FinishedAt
	}
	return v
}

// journalEntryView renders one store.UpdateJournalEntry as an UpdateRun —
// GET /api/updates' "journal" array is the raw phase-transition log (last
// 20 per target), one UpdateRun-shaped record per transition rather than
// one per completed run; its started_at is that entry's own timestamp.
func journalEntryView(e store.UpdateJournalEntry) updateRunView {
	return updateRunView{
		RunID: e.RunID, Target: e.Target, Phase: e.Phase,
		VersionFrom: e.VersionFrom, VersionTo: e.VersionTo,
		StartedAt: e.TS, Detail: e.Detail,
	}
}

// targetStatusView mirrors one entry of openapi UpdatesStatus.targets.
type targetStatusView struct {
	Target         string            `json:"target"`
	CurrentVersion string            `json:"current_version"`
	Releases       []releaseItemView `json:"releases"`
	ActiveRun      *updateRunView    `json:"active_run,omitempty"`
	Journal        []updateRunView   `json:"journal"`
}

// updatesStatusView mirrors openapi UpdatesStatus.
type updatesStatusView struct {
	LockHeld bool               `json:"lock_held"`
	Targets  []targetStatusView `json:"targets"`
}

// handleGetUpdates implements GET /api/updates: both targets' current
// version, filtered release list, active run (if any) and recent journal.
// A release-listing failure for one target (e.g. GitHub unreachable) is
// logged and degrades that target's entry to an empty release list rather
// than failing the whole request — the other target, and the journal/
// active-run data, are still worth returning.
func (s *Server) handleGetUpdates(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), updatesRequestTimeout)
	defer cancel()

	out := updatesStatusView{LockHeld: s.updateEngine.LockHeld()}
	for _, name := range []string{update.TargetTelemt, update.TargetPanel} {
		view, err := s.updateEngine.ReleasesView(ctx, name)
		if err != nil {
			slog.Warn("updates: list releases", "target", name, "err", err)
		}

		releases := make([]releaseItemView, 0, len(view.Releases))
		for _, rv := range view.Releases {
			releases = append(releases, releaseItemView{
				Version: rv.Version, PublishedAt: rv.PublishedAt,
				Prerelease: rv.Prerelease, Newer: rv.Newer,
			})
		}

		ts := targetStatusView{Target: name, CurrentVersion: view.CurrentVersion, Releases: releases}
		if run, ok := s.updateEngine.ActiveRun(name); ok {
			v := runStatusView(run)
			ts.ActiveRun = &v
		}

		entries, err := s.st.ListUpdateJournal(name, 20)
		if err != nil {
			slog.Error("updates: list journal", "target", name, "err", err)
		}
		ts.Journal = make([]updateRunView, 0, len(entries))
		for _, e := range entries {
			ts.Journal = append(ts.Journal, journalEntryView(e))
		}

		out.Targets = append(out.Targets, ts)
	}

	writeJSON(w, http.StatusOK, out)
}

// applyUpdateRequest mirrors the POST /api/updates/{target}/apply request body.
type applyUpdateRequest struct {
	Version string `json:"version"`
}

// handleApplyUpdate implements POST /api/updates/{target}/apply: starts a
// run (StartApply returns as soon as the global lock is acquired and the
// run's goroutine has been spawned) and reports 202, or 409 update_locked
// if another run already holds the lock. Progress streams via the SSE
// "update" topic, not this response.
func (s *Server) handleApplyUpdate(w http.ResponseWriter, r *http.Request) {
	target := r.PathValue("target")
	if target != update.TargetTelemt && target != update.TargetPanel {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "target must be telemt or panel")
		return
	}

	var req applyUpdateRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxUpdatesRequestBody)).Decode(&req); err != nil || req.Version == "" {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "version is required")
		return
	}

	if err := s.updateEngine.StartApply(target, req.Version); err != nil {
		if errors.Is(err, update.ErrBusy) {
			auth.WriteError(w, http.StatusConflict, "update_locked", "another update run is in progress")
			return
		}
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not start update")
		return
	}
	s.appendAudit("update.apply", target, req.Version)
	w.WriteHeader(http.StatusAccepted)
}

// autoUpdateSettingsView mirrors openapi AutoUpdateSettings.
type autoUpdateSettingsView struct {
	Telemt   string `json:"telemt"`
	Panel    string `json:"panel"`
	Interval string `json:"interval"`
}

// handleGetAutoUpdate implements GET /api/updates/auto.
func (s *Server) handleGetAutoUpdate(w http.ResponseWriter, r *http.Request) {
	settings, err := update.GetAutoSettings(s.st)
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not read auto-update settings")
		return
	}
	writeJSON(w, http.StatusOK, autoUpdateSettingsView{
		Telemt: settings.Telemt, Panel: settings.Panel, Interval: settings.Interval.String(),
	})
}

// handlePutAutoUpdate implements PUT /api/updates/auto. Persisted to the
// store — the panel never rewrites its config file (openapi description).
func (s *Server) handlePutAutoUpdate(w http.ResponseWriter, r *http.Request) {
	var req autoUpdateSettingsView
	if err := json.NewDecoder(io.LimitReader(r.Body, maxUpdatesRequestBody)).Decode(&req); err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "invalid request body")
		return
	}
	interval, err := time.ParseDuration(req.Interval)
	if err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "interval must be a valid Go duration (e.g. \"6h\")")
		return
	}

	settings := update.AutoSettings{Telemt: req.Telemt, Panel: req.Panel, Interval: interval}
	if err := update.SetAutoSettings(s.st, settings); err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	s.appendAudit("update.auto_change", "", req.Telemt+"/"+req.Panel+"/"+req.Interval)
	w.WriteHeader(http.StatusNoContent)
}
