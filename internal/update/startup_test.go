package update

import (
	"errors"
	"path/filepath"
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
			name:   "panel restarting with a v-prefix mismatch (tag vs ldflags version) still appends done",
			target: TargetPanel,
			seed: []store.UpdateJournalEntry{
				{Target: TargetPanel, RunID: "r1", Phase: PhaseRestarting, VersionFrom: "v1.0.0", VersionTo: "v1.2.3", TS: time.Now()},
			},
			running:    "1.2.3", // ldflags build version, no "v" prefix — same release as VersionTo's GitHub tag
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

// faultyJournalStore wraps a real Store and fails ListUpdateJournal for
// exactly one target, leaving every other method (including the other
// target's journal calls) delegated unchanged.
type faultyJournalStore struct {
	store.Store
	failTarget string
}

func (f *faultyJournalStore) ListUpdateJournal(target string, limit int) ([]store.UpdateJournalEntry, error) {
	if target == f.failTarget {
		return nil, errors.New("boom")
	}
	return f.Store.ListUpdateJournal(target, limit)
}

// TestReconcileStartup_ContinuesPastAPerTargetError covers the deferred
// minor folded into finding 2: a store error reconciling one target (here
// telemt, processed first) must not abort the loop before the other
// target (panel) gets its own reconciliation — each target's outcome is
// independent. The error is still surfaced to the caller, just not at the
// cost of skipping the remaining target.
func TestReconcileStartup_ContinuesPastAPerTargetError(t *testing.T) {
	st, err := store.NewMemory("")
	if err != nil {
		t.Fatalf("store.NewMemory: %v", err)
	}
	defer st.Close()

	if err := st.AppendUpdateJournal(store.UpdateJournalEntry{
		Target: TargetPanel, RunID: "p1", Phase: PhaseRestarting, VersionFrom: "v1.0.0", VersionTo: "v2.0.0", TS: time.Now(),
	}); err != nil {
		t.Fatalf("seed panel: %v", err)
	}

	fs := &faultyJournalStore{Store: st, failTarget: TargetTelemt}
	if err := ReconcileStartup(fs, "v2.0.0"); err == nil {
		t.Fatal("want a non-nil error surfacing the telemt store failure")
	}

	panelEntries, _ := st.ListUpdateJournal(TargetPanel, 20)
	if len(panelEntries) != 2 || panelEntries[0].Phase != PhaseDone {
		t.Errorf("panel journal = %+v, want a trailing done entry despite telemt's store error", panelEntries)
	}
}

// TestReconcileStartupAcrossProcessRestart is the process-boundary
// regression the audit called out (finding P1.1): a journal entry written
// by one *Memory instance backed by a mirror file must still be there,
// intact, for ReconcileStartup running against a brand new *Memory opened
// on the same path — the exact sequence a real self-update restart goes
// through (old process journals + Close()s, new process NewMemory()s the
// same data_dir and calls ReconcileStartup before anything else). Without
// the mirror covering the journal, every one of these subtests would see
// an empty journal and silently no-op.
func TestReconcileStartupAcrossProcessRestart(t *testing.T) {
	t.Run("panel restarting + matching running version reconciles to done", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "mirror.json")
		st1, err := store.NewMemory(path)
		if err != nil {
			t.Fatalf("NewMemory: %v", err)
		}
		if err := st1.AppendUpdateJournal(store.UpdateJournalEntry{
			Target: TargetPanel, RunID: "r1", Phase: PhaseRestarting, VersionFrom: "v1.0.0", VersionTo: "v2.0.0", TS: time.Now(),
		}); err != nil {
			t.Fatalf("seed AppendUpdateJournal: %v", err)
		}
		if err := st1.Close(); err != nil {
			t.Fatalf("Close: %v", err)
		}

		st2, err := store.NewMemory(path) // the new process, after the restart
		if err != nil {
			t.Fatalf("NewMemory (reopen): %v", err)
		}
		defer st2.Close()
		if err := ReconcileStartup(st2, "v2.0.0"); err != nil {
			t.Fatalf("ReconcileStartup: %v", err)
		}

		entries, err := st2.ListUpdateJournal(TargetPanel, 20)
		if err != nil {
			t.Fatalf("ListUpdateJournal: %v", err)
		}
		if len(entries) != 2 || entries[0].Phase != PhaseDone {
			t.Fatalf("panel journal after reconcile = %+v, want it to end in done", entries)
		}
	})

	t.Run("panel restarting + mismatched running version reconciles to rolled_back", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "mirror.json")
		st1, err := store.NewMemory(path)
		if err != nil {
			t.Fatalf("NewMemory: %v", err)
		}
		if err := st1.AppendUpdateJournal(store.UpdateJournalEntry{
			Target: TargetPanel, RunID: "r1", Phase: PhaseRestarting, VersionFrom: "v1.0.0", VersionTo: "v2.0.0", TS: time.Now(),
		}); err != nil {
			t.Fatalf("seed AppendUpdateJournal: %v", err)
		}
		if err := st1.Close(); err != nil {
			t.Fatalf("Close: %v", err)
		}

		st2, err := store.NewMemory(path) // came back running the old binary
		if err != nil {
			t.Fatalf("NewMemory (reopen): %v", err)
		}
		defer st2.Close()
		if err := ReconcileStartup(st2, "v1.0.0"); err != nil {
			t.Fatalf("ReconcileStartup: %v", err)
		}

		entries, err := st2.ListUpdateJournal(TargetPanel, 20)
		if err != nil {
			t.Fatalf("ListUpdateJournal: %v", err)
		}
		if len(entries) != 2 || entries[0].Phase != PhaseRolledBack {
			t.Fatalf("panel journal after reconcile = %+v, want it to end in rolled_back", entries)
		}
	})

	t.Run("telemt dangling installing reconciles to failed", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "mirror.json")
		st1, err := store.NewMemory(path)
		if err != nil {
			t.Fatalf("NewMemory: %v", err)
		}
		if err := st1.AppendUpdateJournal(store.UpdateJournalEntry{
			Target: TargetTelemt, RunID: "r1", Phase: PhaseInstalling, VersionFrom: "v1.0.0", VersionTo: "v2.0.0", TS: time.Now(),
		}); err != nil {
			t.Fatalf("seed AppendUpdateJournal: %v", err)
		}
		if err := st1.Close(); err != nil {
			t.Fatalf("Close: %v", err)
		}

		st2, err := store.NewMemory(path) // the panel process restarted (crash, not self-update)
		if err != nil {
			t.Fatalf("NewMemory (reopen): %v", err)
		}
		defer st2.Close()
		if err := ReconcileStartup(st2, "v1.0.0"); err != nil {
			t.Fatalf("ReconcileStartup: %v", err)
		}

		entries, err := st2.ListUpdateJournal(TargetTelemt, 20)
		if err != nil {
			t.Fatalf("ListUpdateJournal: %v", err)
		}
		if len(entries) != 2 || entries[0].Phase != PhaseFailed {
			t.Fatalf("telemt journal after reconcile = %+v, want it to end in failed", entries)
		}
	})
}

// TestUpdateJournalHistorySurvivesPlainRestart checks the other half of the
// audit finding: not just the pending-confirmation handoff, but ordinary
// update history (terminal entries a completed run already journaled)
// must still be readable after a plain restart with no reconciliation
// needed at all.
func TestUpdateJournalHistorySurvivesPlainRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mirror.json")
	st1, err := store.NewMemory(path)
	if err != nil {
		t.Fatalf("NewMemory: %v", err)
	}
	ts := time.Now()
	seed := []store.UpdateJournalEntry{
		{Target: TargetTelemt, RunID: "r1", Phase: PhaseDone, VersionFrom: "v1.0.0", VersionTo: "v1.1.0", TS: ts},
		{Target: TargetTelemt, RunID: "r2", Phase: PhaseFailed, VersionFrom: "v1.1.0", VersionTo: "v1.2.0", TS: ts.Add(time.Minute)},
	}
	for _, e := range seed {
		if err := st1.AppendUpdateJournal(e); err != nil {
			t.Fatalf("seed AppendUpdateJournal: %v", err)
		}
	}
	if err := st1.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	st2, err := store.NewMemory(path)
	if err != nil {
		t.Fatalf("NewMemory (reopen): %v", err)
	}
	defer st2.Close()

	// No dangling non-terminal entry, so ReconcileStartup must leave the
	// history untouched.
	if err := ReconcileStartup(st2, "v1.2.0"); err != nil {
		t.Fatalf("ReconcileStartup: %v", err)
	}

	entries, err := st2.ListUpdateJournal(TargetTelemt, 20)
	if err != nil {
		t.Fatalf("ListUpdateJournal: %v", err)
	}
	if len(entries) != 2 || entries[0].RunID != "r2" || entries[1].RunID != "r1" {
		t.Fatalf("ListUpdateJournal after reopen = %+v, want [r2, r1] newest-first", entries)
	}
}
