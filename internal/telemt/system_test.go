package telemt

import (
	"context"
	"errors"
	"io"
	"net/http"
	"testing"
)

func TestReadyReturns503WithSuccessEnvelope(t *testing.T) {
	// GET /v1/health/ready answers with the normal {ok:true,...} envelope on
	// both 200 and 503 — a 503 must not surface as an *APIError.
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/health/ready" {
			t.Errorf("path = %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte(`{"ok":true,"data":{"ready":false,"status":"not_ready","reason":"no_healthy_upstreams",
			"admission_open":true,"healthy_upstreams":0,"total_upstreams":1},"revision":"r1"}`))
	})

	ready, err := c.Ready(context.Background())
	if err != nil {
		t.Fatalf("unexpected error on 503 success envelope: %v", err)
	}
	if ready.Ready || ready.Status != "not_ready" || ready.Reason != "no_healthy_upstreams" {
		t.Errorf("ready = %+v", ready)
	}
	if !ready.AdmissionOpen || ready.TotalUpstreams != 1 {
		t.Errorf("ready = %+v", ready)
	}
}

func TestReadyReturns200WhenReady(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true,"data":{"ready":true,"status":"ready",
			"admission_open":true,"healthy_upstreams":1,"total_upstreams":1},"revision":"r1"}`))
	})

	ready, err := c.Ready(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !ready.Ready || ready.Reason != "" {
		t.Errorf("ready = %+v", ready)
	}
}

func TestReload(t *testing.T) {
	var gotBody []byte
	var gotIfMatch string
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/system/reload" {
			t.Errorf("method/path = %s %s", r.Method, r.URL.Path)
		}
		gotIfMatch = r.Header.Get("If-Match")
		buf, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read request body: %v", err)
		}
		gotBody = buf
		w.WriteHeader(http.StatusAccepted)
		w.Write([]byte(`{"ok":true,"data":{"reload_id":7,"target_generation":4,"config_revision":"r2",
			"state":"accepted","mode":"drain","failure_policy":"keep_new"},"revision":"r2"}`))
	})

	timeout := uint64(30)
	req := ReloadRequest{Mode: ReloadModeDrain, TimeoutSecs: &timeout}
	accepted, revision, err := c.Reload(context.Background(), req, "r1")
	if err != nil {
		t.Fatal(err)
	}
	if accepted.ReloadID != 7 || accepted.State != ReloadPhaseAccepted || accepted.Mode != ReloadModeDrain {
		t.Errorf("accepted = %+v", accepted)
	}
	if revision != "r2" {
		t.Errorf("revision = %q", revision)
	}
	if gotIfMatch != "r1" {
		t.Errorf("If-Match = %q, want r1", gotIfMatch)
	}
	if string(gotBody) != `{"mode":"drain","timeout_secs":30}` {
		t.Errorf("sent body = %s", gotBody)
	}
}

func TestReloadConflict(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		w.Write([]byte(`{"ok":false,"error":{"code":"revision_conflict","message":"config changed"},"request_id":1}`))
	})

	_, _, err := c.Reload(context.Background(), ReloadRequest{}, "stale")
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Code != "revision_conflict" {
		t.Fatalf("err = %v", err)
	}
}

func TestReloadStatus(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/system/reload/7" {
			t.Errorf("path = %s", r.URL.Path)
		}
		w.Write([]byte(`{"ok":true,"data":{"reload_id":7,"target_generation":4,"config_revision":"r2",
			"state":"succeeded","mode":"instant","failure_policy":"keep_new",
			"requested_at_epoch_secs":5000,"started_at_epoch_secs":5001,"finished_at_epoch_secs":5002},"revision":"r2"}`))
	})

	status, err := c.ReloadStatus(context.Background(), 7)
	if err != nil {
		t.Fatal(err)
	}
	if status.State != ReloadPhaseSucceeded || status.StartedAtEpochSecs == nil || *status.StartedAtEpochSecs != 5001 {
		t.Errorf("status = %+v", status)
	}
	if status.Warnings != nil {
		t.Errorf("warnings = %+v, want nil (omitted field)", status.Warnings)
	}
}

func TestReloadStatusNotFound(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"ok":false,"error":{"code":"reload_not_found","message":"Reload 99 was not found"},"request_id":1}`))
	})

	_, err := c.ReloadStatus(context.Background(), 99)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Code != "reload_not_found" {
		t.Fatalf("err = %v", err)
	}
}
