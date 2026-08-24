package update

import (
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
)

// ReconcileStartup completes any dangling update run left behind by a
// previous process instance, for both targets. Call once, early in
// cmd/panel's main(), right after opening the store and before anything
// else that assumes a settled update state.
//
// A run's journal entry sequence normally ends in a terminal phase (done,
// rolled_back, failed) written by the very run that produced it. Two
// distinct ways that guarantee can break, both detectable only from a NEW
// process's startup — never from inside the run that got interrupted:
//
//   - Panel self-update, by design (spec 03-update-engine.md §Журнал):
//     runPhases stops after journaling "restarting" for target=panel and
//     deliberately never claims success itself, because the restart it
//     just triggered may replace this very process before it could — the
//     entry is left pending on purpose, for this function to complete
//     once a live process of the new version exists to confirm it. For
//     this exact case (target=panel, last phase="restarting"): running ==
//     its version_to appends "done"; anything else appends "rolled_back"
//     ("restarted with old binary").
//
//   - Anything else non-terminal: the panel process was simply killed (or
//     crashed) mid-run — for target=telemt at any phase, since telemt has
//     no equivalent "pending on purpose" state, or for target=panel at a
//     non-terminal phase other than "restarting" (e.g. it died mid
//     download, before ever reaching the point where a restart could hand
//     off to a new process). There is no live process of a specific
//     expected version to confirm anything in this case, so the only
//     correct move is "failed" — appended with RunID/VersionFrom/VersionTo
//     carried over from the dangling entry — not a guessed done/rolled_back.
//
// A target whose last journal entry is already terminal, or has no
// entries at all, is left untouched.
func ReconcileStartup(st store.Store, running string) error {
	for _, target := range []string{TargetTelemt, TargetPanel} {
		if err := reconcileTargetStartup(st, target, running); err != nil {
			return err
		}
	}
	return nil
}

// reconcileTargetStartup is ReconcileStartup's per-target logic.
func reconcileTargetStartup(st store.Store, target, running string) error {
	entries, err := st.ListUpdateJournal(target, 1)
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		return nil
	}
	last := entries[0]
	if isTerminalPhase(last.Phase) {
		return nil
	}

	phase := PhaseFailed
	detail := "interrupted before completion"
	if target == TargetPanel && last.Phase == PhaseRestarting {
		phase = PhaseDone
		detail = ""
		if running != last.VersionTo {
			phase = PhaseRolledBack
			detail = "restarted with old binary"
		}
	}

	return st.AppendUpdateJournal(store.UpdateJournalEntry{
		Target:      target,
		RunID:       last.RunID,
		Phase:       phase,
		VersionFrom: last.VersionFrom,
		VersionTo:   last.VersionTo,
		TS:          time.Now(),
		Detail:      detail,
	})
}
