package webui

import (
	"bytes"
	"compress/gzip"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestLicenseAssetsArePublicTextWithBasePath(t *testing.T) {
	files := fixtureFS()
	for _, name := range []string{"LICENSE", "THIRD_PARTY_NOTICES"} {
		var packed bytes.Buffer
		writer := gzip.NewWriter(&packed)
		_, _ = writer.Write([]byte(name + " permissions and attribution\n"))
		_ = writer.Close()
		files["licenses/"+name+".txt.gz"] = &fstest.MapFile{Data: packed.Bytes()}
	}
	handler, err := New(files, "/panel")
	if err != nil {
		t.Fatal(err)
	}
	public := http.StripPrefix("/panel", handler)
	for _, name := range []string{"LICENSE", "THIRD_PARTY_NOTICES"} {
		for _, encoding := range []string{"identity", "gzip"} {
			req := httptest.NewRequest("GET", "/panel/licenses/"+name+".txt", nil)
			req.Header.Set("Accept-Encoding", encoding)
			response := httptest.NewRecorder()
			public.ServeHTTP(response, req)
			if response.Code != 200 || response.Header().Get("Content-Type") != "text/plain; charset=utf-8" || response.Header().Get("Cache-Control") != "no-cache" {
				t.Fatalf("license response: %d %v", response.Code, response.Header())
			}
			body := response.Body.Bytes()
			if encoding == "gzip" {
				reader, err := gzip.NewReader(bytes.NewReader(body))
				if err != nil {
					t.Fatal(err)
				}
				body, err = io.ReadAll(reader)
				_ = reader.Close()
				if err != nil {
					t.Fatal(err)
				}
			}
			if !strings.Contains(string(body), name) {
				t.Fatal("license content missing")
			}
		}
	}
	response := httptest.NewRecorder()
	public.ServeHTTP(response, httptest.NewRequest("GET", "/panel/licenses/missing.txt", nil))
	if response.Code != 404 {
		t.Fatal("missing license returned the SPA")
	}
}

func TestBuiltLicensesAreEmbedded(t *testing.T) {
	if _, err := fs.Stat(Embedded(), "index.html"); err != nil {
		t.Skip("frontend not built; release CI builds it before testing")
	}
	handler, err := New(Embedded(), "")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"LICENSE", "THIRD_PARTY_NOTICES"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", "/licenses/"+name+".txt", nil))
		if response.Code != 200 || !strings.HasPrefix(response.Header().Get("Content-Type"), "text/plain") || response.Body.Len() < 100 {
			t.Fatalf("missing embedded %s: %d %s", name, response.Code, response.Header().Get("Content-Type"))
		}
	}
}
