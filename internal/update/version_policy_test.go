package update

import (
	"context"
	"path/filepath"
	"testing"
)

func TestPanelCatalogOnlyListsVersionOne(t *testing.T) {
	fixture := newFakeReleaseServer(t)
	asset := Asset{Name: AssetName("telemt-panel", "x86_64", "musl"), BrowserDownloadURL: fixture.URL + "/assets/panel"}
	for _, version := range []string{"v2.0.0", "v0.6.2", "v1.0.2", "v1.0.0-rc.1", "v1.0.0", "not-a-version"} {
		fixture.releases = append(fixture.releases, Release{Tag: version, Assets: []Asset{asset}})
	}
	target := &fakeTarget{name: TargetPanel, repo: "owner/panel", version: "v1.0.1"}
	e, _ := newTestEngine(t, fixture, newTestRunner(), map[string]Target{TargetPanel: target}, nil)
	view, err := e.ReleasesView(context.Background(), TargetPanel)
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Releases) != 3 {
		t.Fatalf("catalog contains unsupported branches: %+v", view.Releases)
	}
	for i, want := range []string{"v1.0.2", "v1.0.0", "v1.0.0-rc.1"} {
		if view.Releases[i].ChecksumRequired || view.Releases[i].Asset.Name == "" {
			t.Fatal("panel preview must expose checksum policy and preserve archive discovery")
		}
		if view.Releases[i].Version != want {
			t.Fatalf("release %d: %s", i, view.Releases[i].Version)
		}
	}
}

func TestPanelRejectsUnsupportedVersionsBeforeAnySideEffects(t *testing.T) {
	for _, version := range []string{"0.6.2", "v0.6.2", "v2.0.0", "latest"} {
		t.Run(version, func(t *testing.T) {
			fixture := newFakeReleaseServer(t)
			runner := newTestRunner()
			target := &fakeTarget{name: TargetPanel, repo: "owner/panel", version: "v1.0.0", binaryPath: filepath.Join(t.TempDir(), "panel")}
			e, st := newTestEngine(t, fixture, runner, map[string]Target{TargetPanel: target}, nil)
			if err := e.StartApply(TargetPanel, version); err == nil {
				waitUnlocked(e)
				t.Error("async apply accepted an unsupported panel version")
			}
			if err := e.Apply(context.Background(), TargetPanel, version); err == nil {
				t.Error("sync apply accepted an unsupported panel version")
			}
			entries, _ := st.ListUpdateJournal(TargetPanel, 20)
			if e.LockHeld() || len(runner.CallsSnapshot()) != 0 || len(entries) != 0 {
				t.Fatal("rejected version acquired lasting state or dispatched work")
			}
		})
	}
}

func TestSupportedPanelUpdateAndTelemtDowngradeStillDispatch(t *testing.T) {
	for _, tc := range []struct{ target, current, next string }{{TargetPanel, "v1.0.0", "v1.0.1"}, {TargetTelemt, "3.5.5", "3.5.4"}} {
		t.Run(tc.target, func(t *testing.T) {
			fixture := newFakeReleaseServer(t)
			runner := newTestRunner()
			setupHappyRelease(fixture, tc.target, buildTarGz(t, assetBaseName(tc.target), []byte("test release binary")))
			fixture.releases[0].Tag = tc.next
			target := &fakeTarget{name: tc.target, repo: "owner/repo", version: tc.current, binaryPath: filepath.Join(t.TempDir(), "binary"), serviceName: tc.target}
			e, st := newTestEngine(t, fixture, runner, map[string]Target{tc.target: target}, nil)
			if err := e.Apply(context.Background(), tc.target, tc.next); err != nil {
				t.Fatal(err)
			}
			entries, _ := st.ListUpdateJournal(tc.target, 20)
			if len(entries) == 0 || entries[0].VersionTo != tc.next {
				t.Fatal("requested version was not used")
			}
			if len(runner.CallsSnapshot()) < 2 {
				t.Fatal("supported release did not install/restart")
			}
		})
	}
}
