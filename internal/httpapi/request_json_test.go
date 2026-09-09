package httpapi

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestDecodeJSONBodyEnforcesEveryRequestLimit(t *testing.T) {
	for _, limit := range []int64{4 << 10, 64 << 10, 256 << 10, 1 << 20} {
		t.Run(strconv.FormatInt(limit, 10), func(t *testing.T) {
			exact := `"` + strings.Repeat("a", int(limit)-2) + `"`
			var got string
			if err := decodeJSONBody(httptest.NewRecorder(), newJSONBodyRequest(strings.NewReader(exact)), &got, jsonBodyOptions{MaxBytes: limit}); err != nil {
				t.Fatalf("exactly %d bytes: %v", limit, err)
			}
			if int64(len(got)) != limit-2 {
				t.Fatalf("decoded string length = %d, want %d", len(got), limit-2)
			}

			var overflow string
			err := decodeJSONBody(httptest.NewRecorder(), newJSONBodyRequest(strings.NewReader(exact+" ")), &overflow, jsonBodyOptions{MaxBytes: limit})
			var tooLarge *http.MaxBytesError
			if !errors.As(err, &tooLarge) || tooLarge.Limit != limit {
				t.Fatalf("%d+1 bytes error = %v, want MaxBytesError(%d)", limit, err, limit)
			}
		})
	}
}

func TestDecodeJSONBodyReadsTheCompleteStream(t *testing.T) {
	tests := []struct {
		name string
		body io.Reader
	}{
		{name: "unknown content length", body: strings.NewReader(`{"value":7}`)},
		{name: "chunked short reads", body: &shortJSONReader{data: []byte(`{"value":7}`), max: 2}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := newJSONBodyRequest(tc.body)
			req.ContentLength = -1
			if tc.name == "chunked short reads" {
				req.TransferEncoding = []string{"chunked"}
			}
			var got struct {
				Value int `json:"value"`
			}
			if err := decodeJSONBody(httptest.NewRecorder(), req, &got, jsonBodyOptions{MaxBytes: 64}); err != nil {
				t.Fatal(err)
			}
			if got.Value != 7 {
				t.Fatalf("value = %d, want 7", got.Value)
			}
		})
	}
}

func TestDecodeJSONBodyPreservesReadErrors(t *testing.T) {
	want := errors.New("body read failed")
	req := newJSONBodyRequest(&failingJSONReader{data: []byte(`{"value":`), err: want})
	var got any
	err := decodeJSONBody(httptest.NewRecorder(), req, &got, jsonBodyOptions{MaxBytes: 64})
	var readErr *jsonBodyReadError
	if !errors.As(err, &readErr) || !errors.Is(err, want) {
		t.Fatalf("error = %v, want wrapped read error", err)
	}
}

func TestDecodeJSONBodyRejectsOversizeSuffixesBeforeParsing(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
	}{
		{name: "whitespace suffix", body: `{}` + strings.Repeat(" ", 64)},
		{name: "giant unknown field", body: `{"extra":"` + strings.Repeat("x", 64) + `"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var got map[string]any
			err := decodeJSONBody(httptest.NewRecorder(), newJSONBodyRequest(strings.NewReader(tc.body)), &got, jsonBodyOptions{MaxBytes: 64, RejectUnknown: true})
			var tooLarge *http.MaxBytesError
			if !errors.As(err, &tooLarge) {
				t.Fatalf("error = %v, want MaxBytesError", err)
			}
		})
	}
}

func TestDecodeJSONBodyRequiresOneValue(t *testing.T) {
	for _, suffix := range []string{`{}`, `null`, `1`, `garbage`} {
		t.Run(suffix, func(t *testing.T) {
			var got map[string]any
			err := decodeJSONBody(httptest.NewRecorder(), newJSONBodyRequest(strings.NewReader(`{}`+suffix)), &got, jsonBodyOptions{MaxBytes: 64})
			if !errors.Is(err, errJSONBodyTrailingData) {
				t.Fatalf("error = %v, want trailing-data sentinel", err)
			}
		})
	}

	var got map[string]any
	if err := decodeJSONBody(httptest.NewRecorder(), newJSONBodyRequest(strings.NewReader("{} \n\t")), &got, jsonBodyOptions{MaxBytes: 64}); err != nil {
		t.Fatalf("trailing whitespace: %v", err)
	}
}

func TestDecodeJSONBodyEmptyAndUnknownFieldOptions(t *testing.T) {
	type request struct {
		Value int `json:"value"`
	}

	t.Run("actual empty allowed", func(t *testing.T) {
		got := request{Value: 9}
		req := newJSONBodyRequest(bytes.NewReader(nil))
		req.ContentLength = -1
		if err := decodeJSONBody(httptest.NewRecorder(), req, &got, jsonBodyOptions{MaxBytes: 64, AllowEmpty: true}); err != nil {
			t.Fatal(err)
		}
		if got.Value != 9 {
			t.Fatalf("empty body changed destination: %+v", got)
		}
	})

	for _, tc := range []struct {
		name       string
		body       string
		allowEmpty bool
	}{
		{name: "empty rejected", body: ""},
		{name: "whitespace remains invalid", body: " \n\t", allowEmpty: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var got request
			if err := decodeJSONBody(httptest.NewRecorder(), newJSONBodyRequest(strings.NewReader(tc.body)), &got, jsonBodyOptions{MaxBytes: 64, AllowEmpty: tc.allowEmpty}); err == nil {
				t.Fatal("error = nil, want invalid body")
			}
		})
	}

	t.Run("strict", func(t *testing.T) {
		var got request
		if err := decodeJSONBody(httptest.NewRecorder(), newJSONBodyRequest(strings.NewReader(`{"value":1,"extra":2}`)), &got, jsonBodyOptions{MaxBytes: 64, RejectUnknown: true}); err == nil {
			t.Fatal("unknown field accepted in strict mode")
		}
	})
	t.Run("tolerant and root null", func(t *testing.T) {
		got := request{Value: 9}
		if err := decodeJSONBody(httptest.NewRecorder(), newJSONBodyRequest(strings.NewReader(`{"value":1,"extra":2}`)), &got, jsonBodyOptions{MaxBytes: 64}); err != nil || got.Value != 1 {
			t.Fatalf("tolerant decode = %+v, %v", got, err)
		}
		got.Value = 9
		if err := decodeJSONBody(httptest.NewRecorder(), newJSONBodyRequest(strings.NewReader(`null`)), &got, jsonBodyOptions{MaxBytes: 64}); err != nil || got.Value != 9 {
			t.Fatalf("root null changed semantics: %+v, %v", got, err)
		}
	})
}

func newJSONBodyRequest(body io.Reader) *http.Request {
	return httptest.NewRequest(http.MethodPost, "/", body)
}

type shortJSONReader struct {
	data []byte
	max  int
}

func (r *shortJSONReader) Read(p []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, io.EOF
	}
	n := min(len(r.data), min(len(p), r.max))
	copy(p, r.data[:n])
	r.data = r.data[n:]
	return n, nil
}

type failingJSONReader struct {
	data []byte
	err  error
}

func (r *failingJSONReader) Read(p []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, r.err
	}
	n := copy(p, r.data)
	r.data = r.data[n:]
	return n, nil
}
