package update

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/amirotin/telemt_panel/internal/atomicfile"
	"github.com/amirotin/telemt_panel/internal/host"
	"github.com/amirotin/telemt_panel/internal/host/hosttest"
)

type publicationFailureRunner struct {
	host.Runner
	failKind, failDestination string
}

func (r *publicationFailureRunner) Run(ctx context.Context, op host.Op) (host.Output, error) {
	output, err := r.Runner.Run(ctx, op)
	if err == nil && op.Kind == r.failKind && op.Args[host.ArgDest] == r.failDestination {
		return output, &atomicfile.PublicationError{Err: errors.New("directory sync failed after rename")}
	}
	return output, err
}

func TestUpdatePublicationFailureEvaluatesRollbackVisibility(t *testing.T) {
	for _, failure := range []string{"install", "backup", "restore"} {
		t.Run(failure, func(t *testing.T) {
			binary := filepath.Join(t.TempDir(), "telemt")
			if err := os.WriteFile(binary, []byte("old-binary"), 0o755); err != nil {
				t.Fatal(err)
			}
			fixture := newFakeReleaseServer(t)
			setupHappyRelease(fixture, TargetTelemt, buildTarGz(t, "telemt", []byte("new-binary")))
			target := &fakeTarget{name: TargetTelemt, repo: "owner/repo", binaryPath: binary, serviceName: "telemt", version: "v1.0.0"}
			runner := &publicationFailureRunner{failKind: host.OpInstallBinary, failDestination: binary}
			engine, state := newTestEngine(t, fixture, runner, map[string]Target{TargetTelemt: target}, nil)
			manager := &hosttest.ServiceManager{}
			if failure == "restore" {
				runner.failKind = host.OpRestoreBinary
				manager.RestartFunc = func(string) error { return errors.New("restart failed") }
			}
			if failure == "backup" {
				runner.failDestination = binary + ".bak"
			}
			runner.Runner = host.NewDirectRunner(host.AllowLists{StagingPrefix: engine.stagingDir, BinaryPaths: []string{binary, binary + ".bak"}, Services: []string{"telemt"}}, manager, nil)
			err := engine.Apply(context.Background(), TargetTelemt, "v2.0.0")
			if err == nil || !strings.Contains(err.Error(), "directory sync failed after rename") {
				t.Fatalf("update error=%v", err)
			}
			data, readErr := os.ReadFile(binary)
			if readErr != nil || string(data) != "old-binary" {
				t.Fatalf("installed binary left silently changed=%q error=%v", data, readErr)
			}
			entries, journalErr := state.ListUpdateJournal(TargetTelemt, 1)
			want := PhaseFailed
			if failure == "install" {
				want = PhaseRolledBack
			}
			if journalErr != nil || len(entries) != 1 || entries[0].Phase != want {
				t.Fatalf("journal=%+v error=%v, want %s", entries, journalErr, want)
			}
		})
	}
}
