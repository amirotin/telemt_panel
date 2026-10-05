package geoip

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

type observedProvenance struct {
	OriginalLocation string `json:"original_location"`
	FinalLocation    string `json:"final_location"`
	FetchedEpochSecs int64  `json:"fetched_epoch_secs"`
	SHA256           string `json:"sha256"`
	DatabaseType     string `json:"database_type"`
}

func provenanceFromStatus(t *testing.T, status Status) *observedProvenance {
	t.Helper()
	encoded, err := json.Marshal(status)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Databases []struct {
			Provenance *observedProvenance `json:"provenance"`
		} `json:"databases"`
	}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded.Databases) != 1 {
		t.Fatalf("expected one database: %s", encoded)
	}
	return decoded.Databases[0].Provenance
}

func TestURLProvenanceSurvivesRestartAndFailedSourceSwitch(t *testing.T) {
	fixture, err := os.ReadFile(writeFixture(t, "country"))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(fixture)
	dataDir := t.TempDir()
	settings := newMemorySettings()
	m := NewManager(dataDir, settings)
	defer m.Close()
	loadedAt := int64(2_000_000_000)
	m.now = func() time.Time { return time.Unix(loadedAt, 0) }
	d := newSecureDownloader().(*secureDownloader)
	requests := 0
	d.client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests++
		if request.URL.Host == "origin.test" {
			return &http.Response{StatusCode: http.StatusFound, Header: http.Header{"Location": {"https://mirror.test/db.mmdb?X-Amz-Signature=redirect-secret"}}, Body: io.NopCloser(strings.NewReader(""))}, nil
		}
		return &http.Response{StatusCode: http.StatusOK, Request: request, Body: io.NopCloser(strings.NewReader(string(fixture)))}, nil
	})
	m.client = d
	cfg := Config{Enabled: true, Source: SourceURLs, Schedule: ScheduleManual, Country: DatabaseConfig{Enabled: true, Location: "https://origin.test/country.mmdb?license_key=operator-secret"}}
	if _, err := m.PutConfig(cfg); err != nil {
		t.Fatal(err)
	}
	ready := waitState(t, m, StateReady)
	got := provenanceFromStatus(t, ready)
	want := &observedProvenance{OriginalLocation: "https://origin.test/country.mmdb", FinalLocation: "https://mirror.test/db.mmdb", FetchedEpochSecs: loadedAt, SHA256: hex.EncodeToString(sum[:]), DatabaseType: "GeoIP2-Country"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("provenance = %+v, want %+v", got, want)
	}
	if requests != 2 {
		t.Fatalf("redirect requests = %d", requests)
	}
	// Restore the URL-configured bundle with a downloader that must remain idle.
	startup := NewManager("", settings)
	startup.dataDir, startup.client = dataDir, d
	startup.restore()
	if startup.Status().State != StateReady || requests != 2 || !reflect.DeepEqual(provenanceFromStatus(t, startup.Status()), want) {
		t.Fatalf("startup changed provenance or downloaded: %+v, requests=%d", startup.Status(), requests)
	}
	startup.Close()
	bad := filepath.Join(t.TempDir(), "bad.mmdb")
	if err := os.WriteFile(bad, []byte("not an MMDB"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := m.PutConfig(fileConfig(bad, "", "")); err != nil {
		t.Fatal(err)
	}
	failed := waitState(t, m, StateError)
	if !failed.Available || *failed.LastError != ErrorDatabaseInvalid || !reflect.DeepEqual(provenanceFromStatus(t, failed), want) {
		t.Fatalf("failed switch changed provenance: %+v", failed)
	}
	m.Close()
	restored := NewManager(dataDir, settings)
	defer restored.Close()
	if !restored.Status().Available || !reflect.DeepEqual(provenanceFromStatus(t, restored.Status()), want) {
		t.Fatalf("restart lost provenance: %+v", restored.Status())
	}
	manifest, err := os.ReadFile(filepath.Join(dataDir, "geoip", "active.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(manifest), "secret") || strings.Contains(string(manifest), "Signature") || strings.Contains(string(manifest), "license_key") {
		t.Fatalf("manifest contains URL credentials: %s", manifest)
	}
}

func TestLocalProvenanceRejectsChangedSavedFile(t *testing.T) {
	dataDir := t.TempDir()
	settings := newMemorySettings()
	m := NewManager(dataDir, settings)
	path := writeFixture(t, "country")
	if _, err := m.PutConfig(fileConfig(path, "", "")); err != nil {
		t.Fatal(err)
	}
	status := waitState(t, m, StateReady)
	got := provenanceFromStatus(t, status)
	if got == nil || got.OriginalLocation != path || got.FinalLocation != path || got.FetchedEpochSecs <= 0 || len(got.SHA256) != 64 {
		t.Fatalf("local provenance = %+v", got)
	}
	status.Databases[0].Provenance.SHA256 = "caller mutation"
	if !reflect.DeepEqual(provenanceFromStatus(t, m.Status()), got) {
		t.Fatal("caller mutation changed active provenance")
	}
	m.Close()
	manifest, err := readManifest(filepath.Join(dataDir, "geoip"))
	if err != nil {
		t.Fatal(err)
	}
	other, err := os.ReadFile(writeFixture(t, "optional-country"))
	if err != nil {
		t.Fatal(err)
	}
	saved := filepath.Join(dataDir, "geoip", manifest.Directory, "country.mmdb")
	if err := os.Chmod(saved, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(saved, other, 0o400); err != nil {
		t.Fatal(err)
	}
	restored := NewManager(dataDir, settings)
	defer restored.Close()
	if restored.Status().Available || restored.Status().State != StateError {
		t.Fatalf("changed saved file accepted: %+v", restored.Status())
	}
}

func TestLegacyCommunityRestoreRefusesUpdateWithoutLosingBundle(t *testing.T) {
	dataDir := t.TempDir()
	settings := newMemorySettings()
	m := NewManager(dataDir, settings)
	if _, err := m.PutConfig(fileConfig(writeFixture(t, "country"), "", "")); err != nil {
		t.Fatal(err)
	}
	waitState(t, m, StateReady)
	m.Close()
	cfg := Config{Enabled: true, Source: SourceCommunity, Schedule: ScheduleWeekly, Country: DatabaseConfig{Enabled: true}}
	encoded, _ := json.Marshal(cfg)
	if err := settings.SetSetting(configSettingKey, string(encoded)); err != nil {
		t.Fatal(err)
	}
	manifest, err := readManifest(filepath.Join(dataDir, "geoip"))
	if err != nil {
		t.Fatal(err)
	}
	legacy, _ := json.Marshal(manifest)
	var object map[string]any
	if err := json.Unmarshal(legacy, &object); err != nil {
		t.Fatal(err)
	}
	object["version"], object["source"], object["config_hash"] = 1, SourceCommunity, configHash(cfg)
	delete(object, "provenance")
	legacy, _ = json.Marshal(object)
	manifestPath := filepath.Join(dataDir, "geoip", "active.json")
	if err := os.WriteFile(manifestPath, legacy, 0o600); err != nil {
		t.Fatal(err)
	}
	restored := NewManager(dataDir, settings)
	defer restored.Close()
	if restored.Status().State != StateReady || !restored.Status().Available || provenanceFromStatus(t, restored.Status()) != nil {
		t.Fatalf("legacy restore fabricated provenance or lost bundle: %+v", restored.Status())
	}
	requests := 0
	d := newSecureDownloader().(*secureDownloader)
	d.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) { requests++; return nil, context.Canceled })
	restored.client = d
	if _, err := restored.Update(); err != nil {
		t.Fatal(err)
	}
	status := waitState(t, restored, StateError)
	if requests != 0 || !status.Available || status.LastError == nil || *status.LastError != "source_unconfirmed" {
		t.Fatalf("community refusal = %+v, requests=%d", status, requests)
	}
	if restored.Settings().Config != cfg || restored.Lookup("81.2.69.142") == nil {
		t.Fatal("community refusal changed config or lookup")
	}
	after, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(legacy) {
		t.Fatal("refusal changed saved bundle")
	}
	if restored.refreshDue() {
		t.Fatal("legacy mirror scheduled an automatic download")
	}
}

func TestSuccessfulSourceSwitchReplacesFileProvenance(t *testing.T) {
	dataDir := t.TempDir()
	settings := newMemorySettings()
	m := NewManager(dataDir, settings)
	defer m.Close()
	if _, err := m.PutConfig(fileConfig(writeFixture(t, "country"), "", "")); err != nil {
		t.Fatal(err)
	}
	first := provenanceFromStatus(t, waitState(t, m, StateReady))
	oldManifest, err := readManifest(filepath.Join(dataDir, "geoip"))
	if err != nil {
		t.Fatal(err)
	}
	fixture, err := os.ReadFile(writeFixture(t, "optional-country"))
	if err != nil {
		t.Fatal(err)
	}
	d := newSecureDownloader().(*secureDownloader)
	d.client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Request: request, Body: io.NopCloser(strings.NewReader(string(fixture)))}, nil
	})
	m.client = d
	cfg := Config{Enabled: true, Source: SourceURLs, Schedule: ScheduleManual, Country: DatabaseConfig{Enabled: true, Location: "https://operator.test/country.mmdb?key=secret"}}
	if _, err := m.PutConfig(cfg); err != nil {
		t.Fatal(err)
	}
	status := waitState(t, m, StateReady)
	second := provenanceFromStatus(t, status)
	if status.ActiveSource == nil || *status.ActiveSource != SourceURLs || second == nil || second.SHA256 == first.SHA256 || second.OriginalLocation != "https://operator.test/country.mmdb" {
		t.Fatalf("source switch did not replace provenance: %+v", status)
	}
	if result := m.Lookup("81.2.69.142"); result == nil || result.CountryCode != "GB" || result.CountryName != "" {
		t.Fatalf("replacement MMDB lookup = %+v", result)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "geoip", oldManifest.Directory)); !os.IsNotExist(err) {
		t.Fatalf("old managed bundle retained after successful source switch: %v", err)
	}
	m.Close()
	restored := NewManager(dataDir, settings)
	defer restored.Close()
	if restored.Status().State != StateReady || !reflect.DeepEqual(provenanceFromStatus(t, restored.Status()), second) {
		t.Fatalf("source switch lost provenance after restart: %+v", restored.Status())
	}
}

func TestScheduledWorkerDoesNotDownloadAtStartup(t *testing.T) {
	settings := newMemorySettings()
	cfg := Config{Enabled: true, Source: SourceURLs, Schedule: ScheduleDaily, Country: DatabaseConfig{Enabled: true, Location: "https://operator.test/country.mmdb"}}
	encoded, _ := json.Marshal(cfg)
	if err := settings.SetSetting(configSettingKey, string(encoded)); err != nil {
		t.Fatal(err)
	}
	m := NewManager(t.TempDir(), settings)
	defer m.Close()
	requests := make(chan struct{}, 1)
	d := newSecureDownloader().(*secureDownloader)
	d.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		requests <- struct{}{}
		return nil, context.Canceled
	})
	m.client = d
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { m.Run(ctx); close(done) }()
	select {
	case <-requests:
		cancel()
		<-done
		t.Fatal("scheduled worker downloaded at startup without an explicit operation")
	case <-time.After(100 * time.Millisecond):
		cancel()
		<-done
	}
}
