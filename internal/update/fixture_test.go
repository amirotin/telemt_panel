package update

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/amirotin/telemt_panel/internal/host/hosttest"
)

// buildTarGz returns a tar.gz archive containing exactly one regular-file
// entry, name -> content, for tests exercising extraction/download/verify.
func buildTarGz(t *testing.T, name string, content []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(content)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatalf("tar header: %v", err)
	}
	if _, err := tw.Write(content); err != nil {
		t.Fatalf("tar write: %v", err)
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("tar close: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	return buf.Bytes()
}

// sha256Hex returns data's hex-encoded SHA-256 sum.
func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// fakeReleaseServer serves a GitHub-shaped /repos/{repo}/releases listing
// plus arbitrary asset bytes at caller-chosen paths, for engine tests that
// exercise the full checking->downloading->verifying flow against a real
// (fake) HTTP server rather than mocking Engine's release-listing.
type fakeReleaseServer struct {
	*httptest.Server
	assets   map[string][]byte
	releases []Release
}

func newFakeReleaseServer(t *testing.T) *fakeReleaseServer {
	t.Helper()
	s := &fakeReleaseServer{assets: make(map[string][]byte)}
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(s.releases); err != nil {
			t.Fatalf("encode releases: %v", err)
		}
	})
	mux.HandleFunc("/assets/", func(w http.ResponseWriter, r *http.Request) {
		data, ok := s.assets[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(data)
	})
	s.Server = httptest.NewServer(mux)
	t.Cleanup(s.Close)
	return s
}

// addAsset registers name's bytes at /assets/name and returns its full URL.
func (s *fakeReleaseServer) addAsset(name string, data []byte) string {
	path := "/assets/" + name
	s.assets[path] = data
	return s.URL + path
}

// fakeTarget is a scriptable Target for engine tests.
type fakeTarget struct {
	name        string
	repo        string
	binaryPath  string
	serviceName string
	version     string
	versionErr  error
	postRestart func(ctx context.Context) error
}

func (f *fakeTarget) Name() string { return f.name }
func (f *fakeTarget) CurrentVersion(context.Context) (string, error) {
	return f.version, f.versionErr
}
func (f *fakeTarget) Repo() string        { return f.repo }
func (f *fakeTarget) BinaryPath() string  { return f.binaryPath }
func (f *fakeTarget) ServiceName() string { return f.serviceName }
func (f *fakeTarget) PostRestart(ctx context.Context) error {
	if f.postRestart != nil {
		return f.postRestart(ctx)
	}
	return nil
}

var _ Target = (*fakeTarget)(nil)

// fakePublisher records every PublishUpdate call for assertions. Safe for
// concurrent use — the engine/auto-updater publish from their own
// goroutines while a test reads Published from the test goroutine.
type fakePublisher struct {
	mu        sync.Mutex
	published []json.RawMessage
}

func (f *fakePublisher) PublishUpdate(data json.RawMessage) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.published = append(f.published, data)
}

// Published returns a snapshot of every event recorded so far.
func (f *fakePublisher) Published() []json.RawMessage {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]json.RawMessage, len(f.published))
	copy(out, f.published)
	return out
}

var _ UpdatePublisher = (*fakePublisher)(nil)

// newTestRunner returns a hosttest.Runner usable directly as host.Runner.
func newTestRunner() *hosttest.Runner {
	return &hosttest.Runner{}
}
