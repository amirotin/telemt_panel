package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
)

func TestLegacyDaemonProcessHelper(t *testing.T) {
	path := os.Getenv("TELEMT_TEST_LEGACY_CONFIG")
	if path == "" {
		return
	}
	os.Args = []string{"telemt-panel", "--config", path}
	flag.CommandLine = flag.NewFlagSet("legacy-daemon", flag.ExitOnError)
	main()
}

func TestLegacyDaemonLoginSurvivesRestart(t *testing.T) {
	var mutations atomic.Int32
	telemt := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			mutations.Add(1)
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, "{\"ok\":true,\"data\":{}}")
	}))
	defer telemt.Close()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	path, raw := legacyStartupFixture(t, "daemon-password")
	raw = strings.Replace(raw, "127.0.0.1:48289", address, 1)
	raw = strings.Replace(raw, "http://127.0.0.1:1", telemt.URL, 1)
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(raw), 0400); err != nil {
		t.Fatal(err)
	}
	url := "http://" + address + "/panel"
	client := &http.Client{Timeout: time.Second}
	var session *http.Cookie
	for iteration := range 2 {
		stop := startLegacyTestDaemon(t, path, url, client)
		if iteration == 0 {
			body, _ := json.Marshal(map[string]string{"username": "admin", "password": "daemon-password"})
			response, err := client.Post(url+"/api/auth/login", "application/json", bytes.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != http.StatusNoContent {
				t.Fatalf("legacy password login: %d", response.StatusCode)
			}
			for _, cookie := range response.Cookies() {
				if cookie.Name == auth.CookieName {
					session = cookie
				}
			}
			if session == nil || session.Path != "/panel/" {
				t.Fatal("login did not preserve base-path cookie")
			}
		}
		req, _ := http.NewRequest(http.MethodGet, url+"/api/auth/me", nil)
		req.AddCookie(session)
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("session after startup %d: %d", iteration, response.StatusCode)
		}
		stop()
		after, _ := os.ReadFile(path)
		if string(after) != raw {
			t.Fatal("daemon modified legacy source")
		}
	}
	if mutations.Load() != 0 {
		t.Fatal("startup mutated Telemt")
	}
}

func startLegacyTestDaemon(t *testing.T, path, url string, client *http.Client) func() {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(executable, "-test.run=^TestLegacyDaemonProcessHelper$")
	command.Env = append(os.Environ(), "TELEMT_TEST_LEGACY_CONFIG="+path)
	var output bytes.Buffer
	command.Stdout, command.Stderr = &output, &output
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	stopped := false
	stop := func() {
		if stopped {
			return
		}
		stopped = true
		_ = command.Process.Signal(syscall.SIGTERM)
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("daemon exit: %v\n%s", err, output.String())
			}
		// The server allows 10 seconds for graceful HTTP shutdown; the race
		// runtime also delays process exit after main returns.
		case <-time.After(15 * time.Second):
			_ = command.Process.Kill()
			<-done
			t.Error("daemon did not stop")
		}
	}
	t.Cleanup(stop)
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case err := <-done:
			stopped = true
			t.Fatalf("daemon startup: %v\n%s", err, output.String())
		default:
		}
		response, err := client.Get(url + "/api/health")
		if err == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return stop
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	stop()
	t.Fatal("daemon health timeout")
	return stop
}
