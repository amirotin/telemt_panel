package webui

import (
	"bytes"
	"compress/gzip"
	"io"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"
)

// serveCompressedAsset exposes build-time gzip files under their original URLs.
// The common gzip path reads embedded bytes directly; only identity responses
// allocate an unpacked copy, scoped to that request, never a permanent cache.
func (h *Handler) serveCompressedAsset(w http.ResponseWriter, r *http.Request, name, packedPath, etag string) {
	w.Header().Set("Vary", "Accept-Encoding")
	packed, acceptable := selectGzip(r.Header.Values("Accept-Encoding"))
	if !acceptable {
		http.Error(w, "no acceptable content encoding", http.StatusNotAcceptable)
		return
	}
	file, err := h.fsys.Open(packedPath)
	if err != nil {
		http.Error(w, "asset unavailable", http.StatusInternalServerError)
		return
	}
	defer file.Close()
	var content io.ReadSeeker
	if packed {
		content, _ = file.(io.ReadSeeker)
		if content == nil {
			var b []byte
			b, err = io.ReadAll(file)
			content = bytes.NewReader(b)
		}
	} else {
		var reader *gzip.Reader
		reader, err = gzip.NewReader(file)
		if err == nil {
			var b []byte
			b, err = io.ReadAll(reader)
			reader.Close()
			content = bytes.NewReader(b)
		}
		// The compressed bytes deterministically identify the decoded content,
		// but strong validators must differ between the two representations.
		etag = strings.TrimSuffix(etag, `"`) + `-identity"`
	}
	if err != nil {
		http.Error(w, "asset unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", mime.TypeByExtension(path.Ext(name)))
	w.Header().Set("ETag", etag)
	if packed {
		w.Header().Set("Content-Encoding", "gzip")
		info, err := file.Stat()
		if err != nil {
			w.Header().Del("Content-Encoding")
			http.Error(w, "asset unavailable", http.StatusInternalServerError)
			return
		}
		// ServeContent omits this header for encoded responses to accommodate
		// streaming compressors. Our encoded length is already fixed on disk.
		w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	}
	// ServeContent handles HEAD, ranges and conditional requests against the
	// selected representation, including weak/list If-None-Match validators.
	http.ServeContent(w, r, name, time.Time{}, content)
}

// selectGzip negotiates our gzip and identity representations. An explicit
// coding overrides the wildcard; ties prefer the already compressed bytes.
func selectGzip(headers []string) (packed, acceptable bool) {
	qualities := map[string]float64{}
	for _, item := range strings.Split(strings.Join(headers, ","), ",") {
		parts := strings.Split(item, ";")
		coding := strings.ToLower(strings.TrimSpace(parts[0]))
		if coding != "gzip" && coding != "identity" && coding != "*" {
			continue
		}
		q := 1.0
		for _, parameter := range parts[1:] {
			key, value, ok := strings.Cut(strings.TrimSpace(parameter), "=")
			if !ok || !strings.EqualFold(strings.TrimSpace(key), "q") {
				q = 0
				break
			}
			parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
			if err != nil || !(parsed >= 0 && parsed <= 1) {
				q = 0
				break
			}
			q = parsed
		}
		qualities[coding] = q
	}
	gzipQ, explicit := qualities["gzip"]
	if !explicit {
		gzipQ = qualities["*"]
	}
	identityQ, explicit := qualities["identity"]
	if !explicit {
		identityQ = 1
		if wildcard, present := qualities["*"]; present && wildcard == 0 {
			identityQ = 0
		}
	}
	return gzipQ > 0 && gzipQ >= identityQ, gzipQ > 0 || identityQ > 0
}
