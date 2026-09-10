package paneltls

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/config"
)

func TestRollbackFingerprintAndExactVersion(t *testing.T) {
	type response struct {
		body   string
		status int
	}
	var payload atomic.Value
	payload.Store(response{"<html>old panel</html>", 200})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		value := payload.Load().(response)
		w.WriteHeader(value.status)
		w.Write([]byte(value.body))
	}))
	defer server.Close()
	cfg := &config.Config{Listen: strings.TrimPrefix(server.URL, "http://"), TLS: config.TLSConfig{Mode: "http"}}
	fingerprint, err := Fingerprint(context.Background(), cfg)
	if err != nil || len(fingerprint) != 64 || strings.Contains(fingerprint, "html") {
		t.Fatal("unsafe or invalid baseline fingerprint")
	}
	if err := CheckFingerprint(context.Background(), cfg, fingerprint); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		body   string
		status int
	}{
		{"<html>different service</html>", 200},
		{"<html>old panel</html>", 503},
		{strings.Repeat("x", 65537), 200},
	} {
		payload.Store(response{test.body, test.status})
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		if err := CheckFingerprint(ctx, cfg, fingerprint); err == nil {
			t.Error("invalid rollback response accepted")
		}
		cancel()
	}
	payload.Store(response{`{"status":"ok","version":"1.0.0"}`, 200})
	if err := Check(context.Background(), cfg, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := Check(ctx, cfg, "1.0.1"); err == nil {
		t.Fatal("wrong running version accepted")
	}
	if err := CheckFingerprint(ctx, cfg, "invalid"); err == nil {
		t.Fatal("invalid fingerprint accepted")
	}
}
