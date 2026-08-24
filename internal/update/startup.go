package update

import (
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
)

// ConfirmStartup implements the panel self-update journal handoff (spec
// 03-update-engine.md §Журнал): a panel self-update's runPhases stops
// after journaling "restarting" for target=panel, because the restart it
// just triggered may replace this very process at any moment — "success"
// cannot be claimed by a process that might not survive to say so.
//
// Call this once, early in cmd/panel's main(), after opening the store and
// before anything else that assumes a settled update state. If the last
// journal entry for target=panel is "restarting", this is that handoff:
// running == its version_to means the new binary is up and this call
// appends "done"; anything else (an old/different binary — e.g. the
// install silently failed to take effect, or the restart brought back the
// previous version) appends "rolled_back". Any other last-entry state
// (including no entries at all) is not a pending handoff and is a no-op.
func ConfirmStartup(st store.Store, running string) error {
	entries, err := st.ListUpdateJournal(TargetPanel, 1)
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		return nil
	}
	last := entries[0]
	if last.Phase != PhaseRestarting {
		return nil
	}

	phase := PhaseDone
	detail := ""
	if running != last.VersionTo {
		phase = PhaseRolledBack
		detail = "restarted with old binary"
	}

	return st.AppendUpdateJournal(store.UpdateJournalEntry{
		Target:      TargetPanel,
		RunID:       last.RunID,
		Phase:       phase,
		VersionFrom: last.VersionFrom,
		VersionTo:   last.VersionTo,
		TS:          time.Now(),
		Detail:      detail,
	})
}
