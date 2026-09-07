package telemt

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestTrafficSnapshotReadsCoherentSource(t *testing.T) {
	var mu sync.Mutex
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.URL.Path)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/system/info":
			fmt.Fprint(w, `{"ok":true,"data":{"process_started_at_epoch_secs":1700000000},"revision":"rev-7"}`)
		case "/v1/security/posture":
			fmt.Fprint(w, `{"ok":true,"data":{"telemetry_user_enabled":true},"revision":"rev-7"}`)
		case "/v1/users":
			fmt.Fprint(w, `{"ok":true,"data":[{"username":"alice","total_octets":1234}],"revision":"rev-7"}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	client := New(server.URL, "")
	client.now = func() time.Time { return time.Unix(1700001234, 0) }
	snapshot, err := client.TrafficSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.ObservedAt != 1700001234 || snapshot.SourceStartedAt != 1700000000 || !snapshot.TelemetryEnabled || len(snapshot.Users) != 1 || snapshot.Users[0].TotalOctets != 1234 {
		t.Fatalf("TrafficSnapshot = %+v", snapshot)
	}
	mu.Lock()
	gotPaths := append([]string(nil), paths...)
	mu.Unlock()
	wantPaths := []string{"/v1/system/info", "/v1/security/posture", "/v1/users", "/v1/system/info"}
	if fmt.Sprint(gotPaths) != fmt.Sprint(wantPaths) {
		t.Fatalf("paths = %v, want %v", gotPaths, wantPaths)
	}
}

func TestTrafficSnapshotRejectsRevisionChange(t *testing.T) {
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		revision := "rev-1"
		if calls >= 3 {
			revision = "rev-2"
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/system/info":
			fmt.Fprintf(w, `{"ok":true,"data":{"process_started_at_epoch_secs":1700000000},"revision":%q}`, revision)
		case "/v1/security/posture":
			fmt.Fprintf(w, `{"ok":true,"data":{"telemetry_user_enabled":true},"revision":%q}`, revision)
		case "/v1/users":
			fmt.Fprintf(w, `{"ok":true,"data":[],"revision":%q}`, revision)
		}
	}))
	t.Cleanup(server.Close)

	_, err := New(server.URL, "").TrafficSnapshot(context.Background())
	if !errors.Is(err, ErrInconsistentTrafficSnapshot) {
		t.Fatalf("error = %v, want ErrInconsistentTrafficSnapshot", err)
	}
}

func TestTrafficSnapshotRejectsProcessChange(t *testing.T) {
	var systemCalls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/system/info":
			systemCalls++
			started := 1700000000
			if systemCalls == 2 {
				started++
			}
			fmt.Fprintf(w, `{"ok":true,"data":{"process_started_at_epoch_secs":%d},"revision":"rev-1"}`, started)
		case "/v1/security/posture":
			fmt.Fprint(w, `{"ok":true,"data":{"telemetry_user_enabled":true},"revision":"rev-1"}`)
		case "/v1/users":
			fmt.Fprint(w, `{"ok":true,"data":[],"revision":"rev-1"}`)
		}
	}))
	t.Cleanup(server.Close)

	_, err := New(server.URL, "").TrafficSnapshot(context.Background())
	if !errors.Is(err, ErrInconsistentTrafficSnapshot) {
		t.Fatalf("error = %v, want ErrInconsistentTrafficSnapshot", err)
	}
}
