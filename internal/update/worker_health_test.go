package update

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestWorkerPanelHealthRequiresExactVersionAndReadiness(t *testing.T) {
	for _, body := range []string{`{"status":"ok","version":"1.0.0"}`, `{"status":"starting","version":"1.1.0"}`} {
		t.Run(body, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(body)) }))
			defer server.Close()
			probe := WorkerHealthProbe{PanelURL: server.URL, Client: server.Client(), Timeout: 15 * time.Millisecond, Interval: time.Millisecond}
			if err := probe.Check(context.Background(), TargetPanel, "v1.1.0"); err == nil {
				t.Fatal("unready or wrong version accepted")
			}
		})
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"status":"ok","version":"1.1.0"}`)) }))
	defer server.Close()
	probe := WorkerHealthProbe{PanelURL: server.URL, Client: server.Client(), Timeout: time.Second, Interval: time.Millisecond}
	if err := probe.Check(context.Background(), TargetPanel, "v1.1.0"); err != nil {
		t.Fatal(err)
	}
}

func TestWorkerPanelHealthRejectsCandidateThatImmediatelyExits(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls > 1 {
			http.Error(w, "service stopped", http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte(`{"status":"ok","version":"1.1.0"}`))
	}))
	defer server.Close()
	probe := WorkerHealthProbe{PanelURL: server.URL, Client: server.Client(), Timeout: 20 * time.Millisecond, Interval: time.Millisecond}
	if err := probe.Check(context.Background(), TargetPanel, "1.1.0"); err == nil {
		t.Fatal("single transient healthy response accepted")
	}
}
