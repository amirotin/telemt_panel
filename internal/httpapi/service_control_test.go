package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/host"
	"github.com/amirotin/telemt_panel/internal/host/hosttest"
	"github.com/amirotin/telemt_panel/internal/telemt"
	"github.com/amirotin/telemt_panel/internal/update"
)

func TestServiceControlWorksWithUnavailableTelemtAPI(t *testing.T) {
	s, cookie, _, runner := newRestartTestServer(t)
	s.tc = telemt.New("http://127.0.0.1:1", "")
	var running atomic.Bool
	s.svcMgr = host.NewSystemd(func(context.Context, string, ...string) ([]byte, []byte, error) {
		if running.Load() {
			return []byte("active"), nil, nil
		}
		return []byte("inactive"), nil, nil
	})
	runner.RunFunc = func(op host.Op) (host.Output, error) {
		if op.Args[host.ArgService] != "telemt" {
			t.Error("wrong service", op)
		}
		switch op.Kind {
		case "start-service":
			running.Store(true)
		case "stop-service":
			running.Store(false)
		}
		return host.Output{}, nil
	}
	for _, tc := range []struct{ action, state string }{{"start", "running"}, {"stop", "stopped"}} {
		w := doRequest(t, s, cookie, "POST", "/api/telemt/"+tc.action, nil, nil)
		if w.Code != http.StatusAccepted {
			t.Fatalf("%s = %d: %s", tc.action, w.Code, w.Body)
		}
		w = doRequest(t, s, cookie, "GET", "/api/telemt/service", nil, nil)
		var body struct {
			Status  string `json:"status"`
			Service string `json:"service"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &body) != nil || body.Status != tc.state || body.Service != "telemt" {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}

func TestServiceControlUnknownAndDeniedRemainHonest(t *testing.T) {
	s, cookie, _, runner := newRestartTestServer(t)
	s.svcMgr = host.NewSysvinit(func(context.Context, string, ...string) ([]byte, []byte, error) {
		t.Fatal("status must not run a sysv command")
		return nil, nil, nil
	})
	w := doRequest(t, s, cookie, "GET", "/api/telemt/service", nil, nil)
	var body struct {
		Status          string `json:"status"`
		StatusSupported bool   `json:"status_supported"`
		NativeState     string `json:"native_state"`
		Caps            struct {
			Start bool `json:"start"`
			Stop  bool `json:"stop"`
		}
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &body) != nil || body.Status != "unknown" || body.NativeState != "" || body.StatusSupported || !body.Caps.Start || !body.Caps.Stop {
		t.Fatal(w.Code, w.Body.String())
	}
	s.privilegesMode = host.PrivilegesModeManual
	for _, action := range []string{"start", "stop"} {
		if got := doRequest(t, s, cookie, "POST", "/api/telemt/"+action, nil, nil); got.Code != 503 {
			t.Fatal(action, got.Code)
		}
	}
	if len(runner.CallsSnapshot()) != 0 {
		t.Fatal("manual mode dispatched control")
	}
	s.privilegesMode = host.PrivilegesModeDirect
	s.svcMgr = host.NewSystemd(func(context.Context, string, ...string) ([]byte, []byte, error) {
		return nil, nil, errors.New("status denied")
	})
	w = doRequest(t, s, cookie, "GET", "/api/telemt/service", nil, nil)
	json.Unmarshal(w.Body.Bytes(), &body)
	if body.Status != "unknown" || body.NativeState != "" {
		t.Fatal("failed status became stopped", w.Body.String())
	}
}

func TestServiceControlNeverTargetsPanelBinding(t *testing.T) {
	s, cookie, _, runner := newRestartTestServer(t)
	s.cfg.Host.PanelService = "telemt.service"
	s.svcMgr = host.NewSystemd(func(context.Context, string, ...string) ([]byte, []byte, error) { return nil, nil, nil })
	for _, action := range []string{"start", "stop"} {
		w := doRequest(t, s, cookie, "POST", "/api/telemt/"+action, nil, nil)
		if w.Code != 503 {
			t.Fatal(action, w.Code)
		}
	}
	if len(runner.CallsSnapshot()) != 0 {
		t.Fatal("dispatched control to panel service")
	}
}

func TestManualRestartExcludesBinaryUpdates(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var first atomic.Bool
	runner := &hosttest.Runner{RunFunc: func(op host.Op) (host.Output, error) {
		if op.Kind == host.OpRestartService && first.CompareAndSwap(false, true) {
			close(entered)
			<-release
		}
		return host.Output{}, nil
	}}
	s, cookie, engine := newUpdatesTestServer(t, runner, "v1.0.0")
	s.runner = runner
	s.telemtServiceName = "telemt"
	s.privilegesMode = host.PrivilegesModeDirect
	s.svcMgr = host.NewSystemd(func(context.Context, string, ...string) ([]byte, []byte, error) { return nil, nil, nil })
	done := make(chan int, 1)
	go func() { done <- doRequest(t, s, cookie, "POST", "/api/telemt/restart", nil, nil).Code }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		close(release)
		t.Fatal("restart was not dispatched")
	}
	for _, action := range []string{"start", "stop", "restart"} {
		if w := doRequest(t, s, cookie, "POST", "/api/telemt/"+action, nil, nil); w.Code != 409 {
			t.Errorf("concurrent %s: %d", action, w.Code)
		}
	}
	if engine.HasActiveRun() {
		t.Error("manual service command exposed as an update run")
	}
	if calls := runner.CallsSnapshot(); len(calls) != 1 {
		t.Errorf("concurrent service command reached runner: %+v", calls)
	}
	err := engine.StartApply(update.TargetTelemt, "v2.0.0")
	if !errors.Is(err, update.ErrBusy) {
		t.Errorf("update overlapped manual restart: %v", err)
	}
	close(release)
	if code := <-done; code != 202 {
		t.Fatal(code)
	}
	deadline := time.Now().Add(2 * time.Second)
	for engine.LockHeld() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if engine.LockHeld() {
		t.Fatal("operation lock not released")
	}
}

func TestServiceAuditClassifiesTargetAndUncertainty(t *testing.T) {
	for _, action := range []string{"telemt.start", "telemt.stop", "telemt.start.unconfirmed", "telemt.stop.unconfirmed", "telemt.restart.unconfirmed"} {
		if auditTarget(action, "") != "telemt" {
			t.Error("wrong audit target", action)
		}
		want := "accepted"
		if action != "telemt.start" && action != "telemt.stop" {
			want = "unknown"
		}
		if auditOutcome(action) != want {
			t.Error("wrong audit outcome", action, auditOutcome(action))
		}
		if _, ok := administrativeHistoryEvent(time.Now(), action, ""); !ok {
			t.Error("missing administrative event", action)
		}
	}
}

func TestServiceControlRequiresAuthAndSameOrigin(t *testing.T) {
	s, cookie, _, runner := newRestartTestServer(t)
	s.svcMgr = host.NewSystemd(func(context.Context, string, ...string) ([]byte, []byte, error) {
		t.Fatal("unauthorized request reached host")
		return nil, nil, nil
	})
	for _, action := range []string{"start", "stop", "service"} {
		method := "POST"
		if action == "service" {
			method = "GET"
		}
		r := httptest.NewRequest(method, "/api/telemt/"+action, nil)
		r.Header.Set("Sec-Fetch-Site", "same-origin")
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != 401 {
			t.Errorf("unauthenticated %s: %d", action, w.Code)
		}
		if method == "POST" {
			w = doRequest(t, s, cookie, method, "/api/telemt/"+action, map[string]string{"Sec-Fetch-Site": "cross-site", "Origin": "https://attacker.invalid"}, nil)
			if w.Code != 403 {
				t.Errorf("cross-site %s: %d", action, w.Code)
			}
		}
	}
	if len(runner.CallsSnapshot()) != 0 {
		t.Fatal("unauthorized host command")
	}
}

func TestServiceControlSudoRightsAreIndependent(t *testing.T) {
	s, cookie, _, runner := newRestartTestServer(t)
	s.svcMgr = host.NewSystemd(func(context.Context, string, ...string) ([]byte, []byte, error) { return nil, nil, nil })
	s.privilegesMode = host.PrivilegesModeSudo
	s.serviceStartAllowed = true
	for _, tc := range []struct {
		action string
		want   int
	}{{"start", 202}, {"stop", 503}, {"restart", 202}} {
		w := doRequest(t, s, cookie, "POST", "/api/telemt/"+tc.action, nil, nil)
		if w.Code != tc.want {
			t.Errorf("%s: got %d want %d", tc.action, w.Code, tc.want)
		}
	}
	if calls := runner.CallsSnapshot(); len(calls) != 2 || calls[0].Kind != host.OpStartService || calls[1].Kind != host.OpRestartService {
		t.Fatalf("permission gate dispatched wrong operations: %+v", calls)
	}
}

func TestServiceControlUnconfirmedIsNotRetriedAndReleasesLock(t *testing.T) {
	for _, action := range []string{"start", "stop", "restart"} {
		t.Run(action, func(t *testing.T) {
			s, cookie, _, runner := newRestartTestServer(t)
			s.svcMgr = host.NewSystemd(func(context.Context, string, ...string) ([]byte, []byte, error) { return nil, nil, nil })
			runner.Err = context.DeadlineExceeded
			w := doRequest(t, s, cookie, "POST", "/api/telemt/"+action, nil, nil)
			var body struct {
				Code string `json:"code"`
			}
			if w.Code != 502 || json.Unmarshal(w.Body.Bytes(), &body) != nil || body.Code != "service_action_unconfirmed" {
				t.Fatal(w.Code, w.Body.String())
			}
			if len(runner.CallsSnapshot()) != 1 || s.updateEngine.LockHeld() {
				t.Fatal("uncertain command retried or leaked operation lock")
			}
			entries, _ := s.st.ListAudit(0)
			found := false
			for _, e := range entries {
				if e.Action == "telemt."+action+".unconfirmed" {
					found = true
				}
				if e.Action == "telemt."+action {
					t.Fatal("failed command reported success")
				}
			}
			if !found {
				t.Fatal("missing uncertain command audit")
			}
		})
	}
}

func TestServiceNativeStateUsesOneStatusCommand(t *testing.T) {
	for _, tc := range []struct{ native, normalized string }{
		{"active", "running"}, {"inactive", "stopped"}, {"failed", "stopped"},
		{"activating", "unknown"}, {"deactivating", "unknown"}, {"reloading", "unknown"},
		{"unknown", "unknown"},
	} {
		t.Run(tc.native, func(t *testing.T) {
			s, cookie, _, _ := newRestartTestServer(t)
			calls := 0
			s.svcMgr = host.NewSystemd(func(context.Context, string, ...string) ([]byte, []byte, error) {
				calls++
				return []byte(tc.native + "\n"), nil, &host.ExitError{Code: 3}
			})
			w := doRequest(t, s, cookie, "GET", "/api/telemt/service", nil, nil)
			var body struct {
				Status string `json:"status"`
				Native string `json:"native_state"`
			}
			if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &body) != nil || body.Status != tc.normalized || body.Native != tc.native {
				t.Fatalf("status response: %d %s", w.Code, w.Body)
			}
			if calls != 1 {
				t.Fatalf("status commands = %d, want 1", calls)
			}
		})
	}
}
