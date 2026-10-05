package update

import (
	"errors"
	"fmt"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
)

// PendingPanelRestart identifies the durable handoff awaiting server readiness.
type PendingPanelRestart struct {
	RunID       string
	VersionFrom string
	VersionTo   string
}

// ReconcileInterrupted fails interrupted operations without confirming a restart.
// The pending panel handoff remains unchanged until all required listeners serve.
func ReconcileInterrupted(st store.StateStore, running string) (*PendingPanelRestart, error) {
	var pending *PendingPanelRestart
	var errs []error
	for _, target := range []string{TargetTelemt, TargetPanel} {
		entries, err := st.ListUpdateJournal(target, 1)
		if err != nil {
			errs = append(errs, fmt.Errorf("reconcile %s: %w", target, err))
			continue
		}
		if len(entries) == 0 || isTerminalPhase(entries[0].Phase) {
			continue
		}
		last := entries[0]
		if target == TargetPanel && last.Phase == PhaseRestarting {
			pending = &PendingPanelRestart{last.RunID, last.VersionFrom, last.VersionTo}
			continue
		}
		last.Phase = PhaseFailed
		last.Detail = "interrupted before completion"
		last.TS = time.Now()
		if err := st.AppendUpdateJournal(last); err != nil {
			errs = append(errs, fmt.Errorf("reconcile %s: %w", target, err))
		}
	}
	return pending, errors.Join(errs...)
}

// ConfirmPanelReady confirms the same pending restart only after listener readiness.
func ConfirmPanelReady(st store.StateStore, pending PendingPanelRestart, running string) error {
	entries, err := st.ListUpdateJournal(TargetPanel, 1)
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		return errors.New("update: pending panel restart journal disappeared")
	}
	last := entries[0]
	if last.RunID != pending.RunID || last.Phase != PhaseRestarting || last.VersionFrom != pending.VersionFrom || last.VersionTo != pending.VersionTo {
		return errors.New("update: pending panel restart changed before readiness")
	}
	last.Phase = PhaseDone
	last.Detail = ""
	if CompareVersions(running, pending.VersionTo) != 0 {
		last.Phase = PhaseRolledBack
		last.Detail = "restarted with old binary"
	}
	last.TS = time.Now()
	return st.AppendUpdateJournal(last)
}
