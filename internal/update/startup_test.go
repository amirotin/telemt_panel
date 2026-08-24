package update

import (
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
)

func TestConfirmStartup(t *testing.T) {
	tests := []struct {
		name       string
		seed       []store.UpdateJournalEntry // appended before ConfirmStartup, oldest first
		running    string
		wantAppend bool
		wantPhase  string
		wantDetail string
	}{
		{
			name:       "no journal entries is a no-op",
			seed:       nil,
			running:    "v2.0.0",
			wantAppend: false,
		},
		{
			name: "last entry not restarting is a no-op",
			seed: []store.UpdateJournalEntry{
				{Target: TargetPanel, RunID: "r1", Phase: PhaseDone, VersionTo: "v1.0.0", TS: time.Now()},
			},
			running:    "v1.0.0",
			wantAppend: false,
		},
		{
			name: "restarting with matching running version appends done",
			seed: []store.UpdateJournalEntry{
				{Target: TargetPanel, RunID: "r1", Phase: PhaseRestarting, VersionFrom: "v1.0.0", VersionTo: "v2.0.0", TS: time.Now()},
			},
			running:    "v2.0.0",
			wantAppend: true,
			wantPhase:  PhaseDone,
			wantDetail: "",
		},
		{
			name: "restarting with mismatched running version appends rolled_back",
			seed: []store.UpdateJournalEntry{
				{Target: TargetPanel, RunID: "r1", Phase: PhaseRestarting, VersionFrom: "v1.0.0", VersionTo: "v2.0.0", TS: time.Now()},
			},
			running:    "v1.0.0",
			wantAppend: true,
			wantPhase:  PhaseRolledBack,
			wantDetail: "restarted with old binary",
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

			if err := ConfirmStartup(st, tc.running); err != nil {
				t.Fatalf("ConfirmStartup: %v", err)
			}

			entries, err := st.ListUpdateJournal(TargetPanel, 20)
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
			if last.RunID != tc.seed[len(tc.seed)-1].RunID {
				t.Errorf("appended run_id = %q, want %q (carried from the restarting entry)", last.RunID, tc.seed[len(tc.seed)-1].RunID)
			}
		})
	}
}
