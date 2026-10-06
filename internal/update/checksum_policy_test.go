package update

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPanelRuntimeUpdateDoesNotRequireChecksum(t *testing.T) {
	for _, profile := range []string{"full", "lite"} {
		for _, checksum := range []string{"missing", "blank", "malformed", "mismatch", "download failure"} {
			t.Run(profile+"/"+checksum, func(t *testing.T) {
				binaryPath := filepath.Join(t.TempDir(), "telemt-panel")
				if err := os.WriteFile(binaryPath, []byte("old-test-binary"), 0o755); err != nil {
					t.Fatal(err)
				}
				fixture := newFakeReleaseServer(t)
				assetName := AssetName("telemt-panel", "x86_64", "musl")
				if profile == "lite" {
					assetName = AssetName("telemt-panel-lite", "x86_64", "musl")
				}
				url := fixture.addAsset(assetName, buildTarGz(t, "telemt-panel", []byte("new-test-binary")))
				assets := []Asset{{Name: assetName, BrowserDownloadURL: url}}
				if checksum != "missing" {
					content := " \n"
					if checksum == "malformed" {
						content = "deadbeef\n"
					} else if checksum == "mismatch" {
						content = strings.Repeat("0", 64) + "  " + assetName + "\n"
					}
					sumURL := fixture.URL + "/absent.sha256"
					if checksum != "download failure" {
						sumURL = fixture.addAsset(assetName+".sha256", []byte(content))
					}
					assets = append(assets, Asset{Name: assetName + ".sha256", BrowserDownloadURL: sumURL})
				}
				fixture.releases = []Release{{Tag: "v1.1.0", Assets: assets}}
				target := &fakeTarget{name: TargetPanel, repo: "owner/repo", binaryPath: binaryPath, serviceName: "panel", version: "v1.0.0"}
				runner := newTestRunner()
				engine, state := newTestEngine(t, fixture, runner, map[string]Target{TargetPanel: target}, nil)
				engine.buildVariant = profile
				err := engine.Apply(context.Background(), TargetPanel, "v1.1.0")
				if err != nil {
					t.Fatalf("panel release checksum=%s: %v", checksum, err)
				}
				if calls := runner.CallsSnapshot(); len(calls) != 3 {
					t.Fatalf("host_operations=%d, want backup/install/restart: %+v", len(calls), calls)
				}
				entries, err := state.ListUpdateJournal(TargetPanel, 20)
				if err != nil || len(entries) == 0 || entries[0].Phase != PhaseRestarting {
					t.Fatalf("journal=%+v error=%v, want pending startup confirmation", entries, err)
				}
			})
		}
	}
}

func TestPanelChecksumSuccessPreservesBuildProfile(t *testing.T) {
	for _, profile := range []string{"full", "lite"} {
		t.Run(profile, func(t *testing.T) {
			fixture := newFakeReleaseServer(t)
			assetName := AssetName("telemt-panel", "x86_64", "musl")
			if profile == "lite" {
				assetName = AssetName("telemt-panel-lite", "x86_64", "musl")
			}
			archive := buildTarGz(t, "telemt-panel", []byte("new-test-binary"))
			url := fixture.addAsset(assetName, archive)
			sumURL := fixture.addAsset(assetName+".sha256", []byte(sha256Hex(archive)+"  "+assetName+"\n"))
			fixture.releases = []Release{{Tag: "v1.1.0", Assets: []Asset{
				{Name: assetName, BrowserDownloadURL: url},
				{Name: assetName + ".sha256", BrowserDownloadURL: sumURL},
			}}}
			target := &fakeTarget{name: TargetPanel, repo: "owner/repo", binaryPath: filepath.Join(t.TempDir(), "telemt-panel"), serviceName: "panel", version: "v1.0.0"}
			runner := newTestRunner()
			engine, state := newTestEngine(t, fixture, runner, map[string]Target{TargetPanel: target}, nil)
			engine.buildVariant = profile
			if err := engine.Apply(context.Background(), TargetPanel, "v1.1.0"); err != nil {
				t.Fatal(err)
			}
			entries, err := state.ListUpdateJournal(TargetPanel, 20)
			if err != nil || len(entries) == 0 || entries[0].Phase != PhaseRestarting {
				t.Fatalf("journal=%+v error=%v, want pending restarting", entries, err)
			}
			if calls := runner.CallsSnapshot(); len(calls) != 2 {
				t.Fatalf("host_operations=%d, want install/restart", len(calls))
			}
		})
	}
}
