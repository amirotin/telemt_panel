package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/host"
)

func TestHandleEventsLogsFileHistoryThenLive(t *testing.T) {
	path := filepath.Join(t.TempDir(), "telemt.log")
	if err := os.WriteFile(path, []byte("existing entry\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	srv, cookie, _, _ := newHostTestServer(t)
	srv.logSrc = host.NewFile(path, time.Millisecond)
	srv.cfg.Host.TelemtService = "S99telemt"
	panel := httptest.NewServer(srv.Handler())
	t.Cleanup(panel.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, panel.URL+"/api/events/logs?service=telemt", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(cookie)
	resp, err := panel.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("response = %d %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	frames := readSSEFrames(resp.Body)
	reset := nextFrame(t, frames, time.Second)
	if reset.event != "log_reset" || reset.data != `{"source":"file"}` {
		t.Fatalf("first frame = %+v, want file snapshot reset", reset)
	}
	assertLine := func(want string) {
		t.Helper()
		frame := nextFrame(t, frames, time.Second)
		if frame.event != "log" {
			t.Fatalf("event = %q, want log: %s", frame.event, frame.data)
		}
		var line apiLogLine
		if err := json.Unmarshal([]byte(frame.data), &line); err != nil {
			t.Fatal(err)
		}
		if line.Msg != want || line.Unit != "S99telemt" {
			t.Fatalf("line = %+v, want %q for S99telemt", line, want)
		}
	}
	assertLine("existing entry")

	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, writeErr := f.WriteString("new entry\nexisting entry\n")
	closeErr := f.Close()
	if writeErr != nil {
		t.Fatal(writeErr)
	}
	if closeErr != nil {
		t.Fatal(closeErr)
	}
	assertLine("new entry")
	assertLine("existing entry")
}

func TestHandleEventsLogsEmptyFileResetsHistory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "telemt.log")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	srv, cookie, _, _ := newHostTestServer(t)
	srv.logSrc = host.NewFile(path, time.Hour)
	panel := httptest.NewServer(srv.Handler())
	t.Cleanup(panel.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, panel.URL+"/api/events/logs?service=telemt", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(cookie)
	resp, err := panel.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	frame := nextFrame(t, readSSEFrames(resp.Body), time.Second)
	if frame.event != "log_reset" || frame.data != `{"source":"file"}` {
		t.Fatalf("first frame = %+v, want file snapshot reset", frame)
	}
}
