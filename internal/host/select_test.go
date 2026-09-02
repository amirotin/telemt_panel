package host

import (
	"context"
	"errors"
	"testing"
)

func TestSelectRunner_OneHostWideTransport(t *testing.T) {
	sudo := &SudoRunner{}
	cases := []struct {
		name          string
		mode          string
		euid          int
		sudoAvailable bool
		wantMode      string
	}{
		{"auto root uses direct", PrivilegesModeAuto, 0, true, PrivilegesModeDirect},
		{"auto non-root uses complete sudo policy", PrivilegesModeAuto, 1000, true, PrivilegesModeSudo},
		{"auto without sudo uses manual mode", PrivilegesModeAuto, 1000, false, PrivilegesModeManual},
		{"empty mode is auto", "", 1000, false, PrivilegesModeManual},
		{"direct can be forced", PrivilegesModeDirect, 1000, false, PrivilegesModeDirect},
		{"sudo can be forced when complete", PrivilegesModeSudo, 1000, true, PrivilegesModeSudo},
		{"incomplete forced sudo falls back to manual", PrivilegesModeSudo, 1000, false, PrivilegesModeManual},
		{"manual can be forced", PrivilegesModeManual, 0, true, PrivilegesModeManual},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			runner, mode := SelectRunner(RunnerSelectionOptions{
				Mode: tc.mode, EUID: tc.euid,
				SudoRunner: sudo, SudoAvailable: tc.sudoAvailable,
			})
			if runner == nil {
				t.Fatal("runner must never be nil")
			}
			if mode != tc.wantMode {
				t.Fatalf("mode = %q, want %q", mode, tc.wantMode)
			}
			if mode == PrivilegesModeSudo && runner != sudo {
				t.Fatal("selection returned a different sudo Runner instance")
			}
		})
	}
}

func TestSelectRunner_ManualRunnerReturnsErrPrivilegesUnavailable(t *testing.T) {
	runner, mode := SelectRunner(RunnerSelectionOptions{Mode: PrivilegesModeAuto, EUID: 1000})
	if mode != PrivilegesModeManual {
		t.Fatalf("mode = %q, want manual", mode)
	}
	_, err := runner.Run(context.Background(), Op{Kind: OpRestartService, Args: map[string]string{ArgService: "telemt"}})
	if !errors.Is(err, ErrPrivilegesUnavailable) {
		t.Errorf("err = %v, want ErrPrivilegesUnavailable", err)
	}
}
