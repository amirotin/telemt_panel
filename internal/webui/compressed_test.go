package webui

import (
	"bytes"
	"compress/gzip"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
)

func compressedFixture(t testing.TB) (fstest.MapFS, []byte, []byte) {
	t.Helper()
	plain := []byte(strings.Repeat("console.log('compressed asset');\n", 100))
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	if _, err := w.Write(plain); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	files := fixtureFS()
	delete(files, "assets/index-abc123.js")
	files["assets/index-abc123.js.gz"] = &fstest.MapFile{Data: buf.Bytes()}
	files["assets/style-abc123.css.gz"] = &fstest.MapFile{Data: buf.Bytes()}
	files["sw.js.gz"] = &fstest.MapFile{Data: buf.Bytes()}
	return files, plain, buf.Bytes()
}

func TestCompressedAssetNegotiation(t *testing.T) {
	files, plain, packed := compressedFixture(t)
	h, err := New(files, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, accept, encoding string
		status                 int
	}{
		{"gzip", "gzip", "gzip", 200},
		{"modern browser", "gzip, deflate, br, zstd", "gzip", 200},
		{"case insensitive", "GZip;Q=1", "gzip", 200},
		{"absent", "", "", 200},
		{"identity", "identity", "", 200},
		{"unsupported", "br", "", 200},
		{"disabled gzip", "gzip;q=0", "", 200},
		{"wildcard", "*;q=1", "gzip", 200},
		{"explicit overrides wildcard", "gzip;q=0, *;q=1", "", 200},
		{"prefer identity", "gzip;q=0.2, identity;q=0.8", "", 200},
		{"prefer gzip", "gzip;q=0.8, identity;q=0.2", "gzip", 200},
		{"invalid quality", "gzip;q=NaN", "", 200},
		{"out of range", "gzip;q=2", "", 200},
		{"nothing accepted", "gzip;q=0, identity;q=0", "", 406},
		{"wildcard refusal", "*;q=0", "", 406},
		{"gzip exception", "gzip, *;q=0", "gzip", 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/assets/index-abc123.js", nil)
			if tc.accept != "" {
				req.Header.Set("Accept-Encoding", tc.accept)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.status {
				t.Fatalf("status=%d want=%d", rec.Code, tc.status)
			}
			if got := rec.Header().Get("Content-Encoding"); got != tc.encoding {
				t.Fatalf("encoding=%q", got)
			}
			if rec.Header().Get("Vary") != "Accept-Encoding" {
				t.Fatal("missing encoding cache variation")
			}
			if tc.status != 200 {
				return
			}
			want := plain
			if tc.encoding == "gzip" {
				want = packed
			}
			if !bytes.Equal(rec.Body.Bytes(), want) {
				t.Fatal("wrong representation body")
			}
			if rec.Header().Get("Content-Length") != strconv.Itoa(len(want)) {
				t.Fatal("wrong representation length")
			}
			if !strings.Contains(rec.Header().Get("Content-Type"), "javascript") {
				t.Fatal("wrong logical MIME type")
			}
			if rec.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
				t.Fatal("lost immutable caching")
			}
		})
	}
}

func TestCompressedAssetValidatorsAndHead(t *testing.T) {
	files, _, _ := compressedFixture(t)
	h, err := New(files, "/panel")
	if err != nil {
		t.Fatal(err)
	}
	get := func(method, accept, match string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/assets/index-abc123.js", nil)
		req.Header.Set("Accept-Encoding", accept)
		req.Header.Set("If-None-Match", match)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	identity, packed := get("GET", "identity", ""), get("GET", "gzip", "")
	if identity.Code != 200 || packed.Code != 200 {
		t.Fatal("missing logical asset")
	}
	if identity.Header().Get("ETag") == packed.Header().Get("ETag") {
		t.Fatal("representations share a strong ETag")
	}
	for _, encoding := range []string{"identity", "gzip"} {
		first := get("GET", encoding, "")
		for _, match := range []string{first.Header().Get("ETag"), "W/" + first.Header().Get("ETag"), `"other", ` + first.Header().Get("ETag"), "*"} {
			rec := get("GET", encoding, match)
			if rec.Code != 304 || rec.Body.Len() != 0 {
				t.Fatalf("revalidation %s: %d", match, rec.Code)
			}
			if rec.Header().Get("Vary") != "Accept-Encoding" {
				t.Fatal("304 lost Vary")
			}
		}
		head := get("HEAD", encoding, "")
		if head.Code != 200 || head.Body.Len() != 0 {
			t.Fatal("bad HEAD")
		}
		for _, key := range []string{"Content-Length", "Content-Type", "Content-Encoding", "ETag", "Vary"} {
			if head.Header().Get(key) != first.Header().Get(key) {
				t.Fatalf("HEAD differs on %s", key)
			}
		}
	}
	if get("GET", "identity", packed.Header().Get("ETag")).Code != 200 {
		t.Fatal("gzip ETag incorrectly validates identity")
	}
	if get("GET", "gzip", identity.Header().Get("ETag")).Code != 200 {
		t.Fatal("identity ETag incorrectly validates gzip")
	}
}

func TestCompressedAssetRangesAndPaths(t *testing.T) {
	files, plain, packed := compressedFixture(t)
	h, err := New(files, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, encoding := range []string{"identity", "gzip"} {
		req := httptest.NewRequest("GET", "/assets/index-abc123.js", nil)
		req.Header.Set("Accept-Encoding", encoding)
		req.Header.Set("Range", "bytes=0-9")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		want := plain
		if encoding == "gzip" {
			want = packed
		}
		if rec.Code != 206 || !bytes.Equal(rec.Body.Bytes(), want[:10]) {
			t.Fatalf("bad range for %s: %d", encoding, rec.Code)
		}
	}
	for _, path := range []string{"/assets/index-abc123.js.gz", "/sw.js.gz", "/assets/missing.js"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		if rec.Code != 404 {
			t.Fatalf("internal/missing path %s status=%d", path, rec.Code)
		}
	}
	for _, tc := range []struct{ path, contentType, cache string }{
		{"/assets/style-abc123.css", "text/css", "public, max-age=31536000, immutable"},
		{"/sw.js", "javascript", "no-cache"},
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", tc.path, nil)
		req.Header.Set("Accept-Encoding", "gzip")
		h.ServeHTTP(rec, req)
		if rec.Code != 200 || !strings.Contains(rec.Header().Get("Content-Type"), tc.contentType) || rec.Header().Get("Cache-Control") != tc.cache {
			t.Fatalf("wrong logical headers on %s", tc.path)
		}
	}
}

func TestCompressedAssetWithHTTPTransport(t *testing.T) {
	files, plain, _ := compressedFixture(t)
	h, err := New(files, "")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(h)
	defer server.Close()
	// net/http's default transport requests gzip and transparently decodes it.
	resp, err := server.Client().Get(server.URL + "/assets/index-abc123.js")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK || !resp.Uncompressed || !bytes.Equal(body, plain) {
		t.Fatal("transparent gzip client failed")
	}
}

func TestBuiltAssetsContainOnlyCompressedScriptsAndStyles(t *testing.T) {
	files := Embedded()
	if _, err := fs.Stat(files, "index.html"); err != nil {
		t.Skip("frontend not built")
	}
	h, err := New(files, "")
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	err = fs.WalkDir(files, ".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		if strings.HasSuffix(path, ".js") || strings.HasSuffix(path, ".css") {
			t.Errorf("uncompressed source embedded: %s", path)
		}
		if !strings.HasSuffix(path, ".js.gz") && !strings.HasSuffix(path, ".css.gz") {
			return nil
		}
		count++
		packed, err := fs.ReadFile(files, path)
		if err != nil {
			return err
		}
		reader, err := gzip.NewReader(bytes.NewReader(packed))
		if err != nil {
			return err
		}
		plain, err := io.ReadAll(reader)
		reader.Close()
		if err != nil {
			return err
		}
		for _, encoding := range []string{"gzip", "identity"} {
			req := httptest.NewRequest("GET", "/"+strings.TrimSuffix(path, ".gz"), nil)
			req.Header.Set("Accept-Encoding", encoding)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			want := packed
			if encoding == "identity" {
				want = plain
			}
			if rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), want) {
				t.Errorf("built %s not served as %s", path, encoding)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if count == 0 {
		t.Fatal("built frontend has no compressed assets")
	}
}
