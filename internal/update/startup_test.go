package update

import (
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
)

func TestReconcileStartup(t *testing.T) {
	tests := []struct {
		name       string
		target     string
		seed       []store.UpdateJournalEntry // appended before ReconcileStartup, oldest first
		running    string
		wantAppend bool
		wantPhase  string
		wantDetail string
	}{
		{
			name:       "empty journal is a no-op",
			target:     TargetPanel,
			seed:       nil,
			running:    "v2.0.0",
			wantAppend: false,
		},
		{
			name:   "panel terminal entry (done) is untouched",
			target: TargetPanel,
			seed: []store.UpdateJournalEntry{
				{Target: TargetPanel, RunID: "r1", Phase: PhaseDone, VersionTo: "v1.0.0", TS: time.Now()},
			},
			running:    "v1.0.0",
			wantAppend: false,
		},
		{
			name:   "telemt terminal entry (failed) is untouched",
			target: TargetTelemt,
			seed: []store.UpdateJournalEntry{
				{Target: TargetTelemt, RunID: "r1", Phase: PhaseFailed, VersionTo: "v1.0.0", TS: time.Now()},
			},
			running:    "v1.0.0",
			wantAppend: false,
		},
		{
			name:   "panel restarting with matching running version appends done",
			target: TargetPanel,
			seed: []store.UpdateJournalEntry{
				{Target: TargetPanel, RunID: "r1", Phase: PhaseRestarting, VersionFrom: "v1.0.0", VersionTo: "v2.0.0", TS: time.Now()},
			},
			running:    "v2.0.0",
			wantAppend: true,
			wantPhase:  PhaseDone,
			wantDetail: "",
		},
		{
			name:   "panel restarting with mismatched running version appends rolled_back",
			target: TargetPanel,
			seed: []store.UpdateJournalEntry{
				{Target: TargetPanel, RunID: "r1", Phase: PhaseRestarting, VersionFrom: "v1.0.0", VersionTo: "v2.0.0", TS: time.Now()},
			},
			running:    "v1.0.0",
			wantAppend: true,
			wantPhase:  PhaseRolledBack,
			wantDetail: "restarted with old binary",
		},
		{
			name:   "panel stuck at a non-restarting non-terminal phase (downloading) appends failed",
			target: TargetPanel,
			seed: []store.UpdateJournalEntry{
				{Target: TargetPanel, RunID: "r1", Phase: PhaseDownloading, VersionFrom: "v1.0.0", VersionTo: "v2.0.0", TS: time.Now()},
			},
			running:    "v2.0.0", // irrelevant to this branch — must not turn into done/rolled_back
			wantAppend: true,
			wantPhase:  PhaseFailed,
			wantDetail: "interrupted before completion",
		},
		{
			name:   "telemt stuck at installing appends failed (telemt has no restarting handoff)",
			target: TargetTelemt,
			seed: []store.UpdateJournalEntry{
				{Target: TargetTelemt, RunID: "r1", Phase: PhaseInstalling, VersionFrom: "v1.0.0", VersionTo: "v2.0.0", TS: time.Now()},
			},
			running:    "v1.0.0", // the panel's own version — irrelevant to a telemt entry
			wantAppend: true,
			wantPhase:  PhaseFailed,
			wantDetail: "interrupted before completion",
		},
		{
			name:   "telemt stuck at restarting also appends failed, not done/rolled_back (that handoff is panel-only)",
			target: TargetTelemt,
			seed: []store.UpdateJournalEntry{
				{Target: TargetTelemt, RunID: "r1", Phase: PhaseRestarting, VersionFrom: "v1.0.0", VersionTo: "v2.0.0", TS: time.Now()},
			},
			running:    "v2.0.0",
			wantAppend: true,
			wantPhase:  PhaseFailed,
			wantDetail: "interrupted before completion",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			st, err := store.NewMemory("")
			if err != nil {
				t.Fatalf("store.NewMemory: %v", err)
			}
			defer st.Close()
			for _, e := range tc.seed {
				if err := st.AppendUpdateJournal(e); err != nil {
					t.Fatalf("seed AppendUpdateJournal: %v", err)
				}
			}

			if err := ReconcileStartup(st, tc.running); err != nil {
				t.Fatalf("ReconcileStartup: %v", err)
			}

			entries, err := st.ListUpdateJournal(tc.target, 20)
			if err != nil {
				t.Fatalf("ListUpdateJournal: %v", err)
			}

			wantLen := len(tc.seed)
			if tc.wantAppend {
				wantLen++
			}
			if len(entries) != wantLen {
				t.Fatalf("journal len = %d, want %d (entries: %+v)", len(entries), wantLen, entries)
			}
			if !tc.wantAppend {
				return
			}

			last := entries[0] // newest first
			if last.Phase != tc.wantPhase {
				t.Errorf("appended phase = %q, want %q", last.Phase, tc.wantPhase)
			}
			if last.Detail != tc.wantDetail {
				t.Errorf("appended detail = %q, want %q", last.Detail, tc.wantDetail)
			}
			seedLast := tc.seed[len(tc.seed)-1]
			if last.RunID != seedLast.RunID {
				t.Errorf("appended run_id = %q, want %q (carried from the dangling entry)", last.RunID, seedLast.RunID)
			}
			if last.VersionFrom != seedLast.VersionFrom || last.VersionTo != seedLast.VersionTo {
				t.Errorf("appended versions = %s->%s, want %s->%s (carried from the dangling entry)",
					last.VersionFrom, last.VersionTo, seedLast.VersionFrom, seedLast.VersionTo)
			}
		})
	}
}

// TestReconcileStartup_ActsOnBothTargetsIndependently seeds a dangling
// entry for both targets in one store and confirms ReconcileStartup
// resolves each according to its own rule in a single call — the "panel
// restarting" handoff and the generic "failed" fallback don't interfere
// with each other.
func TestReconcileStartup_ActsOnBothTargetsIndependently(t *testing.T) {
	st, err := store.NewMemory("")
	if err != nil {
		t.Fatalf("store.NewMemory: %v", err)
	}
	defer st.Close()

	if err := st.AppendUpdateJournal(store.UpdateJournalEntry{
		Target: TargetTelemt, RunID: "t1", Phase: PhaseInstalling, VersionFrom: "v1.0.0", VersionTo: "v2.0.0", TS: time.Now(),
	}); err != nil {
		t.Fatalf("seed telemt: %v", err)
	}
	if err := st.AppendUpdateJournal(store.UpdateJournalEntry{
		Target: TargetPanel, RunID: "p1", Phase: PhaseRestarting, VersionFrom: "v1.0.0", VersionTo: "v2.0.0", TS: time.Now(),
	}); err != nil {
		t.Fatalf("seed panel: %v", err)
	}

	if err := ReconcileStartup(st, "v2.0.0"); err != nil {
		t.Fatalf("ReconcileStartup: %v", err)
	}

	telemtEntries, _ := st.ListUpdateJournal(TargetTelemt, 20)
	if len(telemtEntries) != 2 || telemtEntries[0].Phase != PhaseFailed {
		t.Errorf("telemt journal = %+v, want a trailing failed entry", telemtEntries)
	}
	panelEntries, _ := st.ListUpdateJournal(TargetPanel, 20)
	if len(panelEntries) != 2 || panelEntries[0].Phase != PhaseDone {
		t.Errorf("panel journal = %+v, want a trailing done entry", panelEntries)
	}
}
