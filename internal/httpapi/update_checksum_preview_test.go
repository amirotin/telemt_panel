package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/amirotin/telemt_panel/internal/host/hosttest"
	"github.com/amirotin/telemt_panel/internal/update"
)

func TestUpdatesChecksumPreviewDescribesRequirementAndAvailability(t *testing.T) {
	s := newTestServer(t)
	gh := newFakeGitHub(t)
	gh.releases = []update.Release{{Tag: "v1.1.0", Assets: []update.Asset{
		{Name: update.AssetName("telemt-panel", "x86_64", "musl"), BrowserDownloadURL: gh.URL + "/panel"},
		{Name: update.AssetName("telemt", "x86_64", "musl"), BrowserDownloadURL: gh.URL + "/telemt"},
	}}}
	client := update.NewClient()
	client.BaseURL = gh.URL
	e := update.NewEngine(update.EngineConfig{Store: s.st, Runner: &hosttest.Runner{}, Github: client, StagingDir: t.TempDir(), Arch: "x86_64", Variant: "musl", Targets: map[string]update.Target{
		update.TargetPanel:  &update.PanelTarget{Version_: "1.0.0", RepoName: "owner/panel", BinaryPath_: "/test/panel", ServiceName_: "panel"},
		update.TargetTelemt: &update.TelemtTarget{Client: newFakeTelemtWithVersion(t, "1.0.0"), RepoName: "owner/telemt", BinaryPath_: "/test/telemt", ServiceName_: "telemt"},
	}})
	defer e.Close()
	s.updateEngine = e
	_, cookie := login(t, s.Handler(), "admin", testPassword)
	r := httptest.NewRequest(http.MethodGet, "/api/updates", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	var status struct {
		Targets []struct {
			Target   string           `json:"target"`
			Releases []map[string]any `json:"releases"`
		} `json:"targets"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &status); err != nil || w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s err=%v", w.Code, w.Body, err)
	}
	for _, target := range status.Targets {
		if len(target.Releases) != 1 {
			t.Fatalf("target%s releases=%v", target.Target, target.Releases)
		}
		release := target.Releases[0]
		if required, present := release["checksum_required"]; !present || required != (target.Target == update.TargetPanel) {
			t.Fatalf("target%s checksum_required=%v", target.Target, release)
		}
		if available, present := release["checksum_available"]; !present || available != false {
			t.Fatalf("missing checksum advertised=%v", release)
		}
	}
}
