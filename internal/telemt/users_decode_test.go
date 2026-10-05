package telemt

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

func TestUsersNormalizationMatchesSharedContract(t *testing.T) {
	for _, body := range []string{`null`, `[]`, `[{}]`, `[{"active_unique_ips_list":["127.0.0.1"],"links":{"classic":["tg://example"],"tls_domains":[{"domain":"example.test","link":"tg://tls"}]}}]`} {
		var got, want []UserInfo
		if err := json.Unmarshal([]byte(body), &got); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal([]byte(body), &want); err != nil {
			t.Fatal(err)
		}
		normalizeUsers(&got)
		normalizeSlices(&want)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("normalization contract changed: %s", body)
		}
	}
}

func TestUsersTypedEnvelopePreservesResponseForms(t *testing.T) {
	for _, tc := range []struct {
		name, body, revision, code string
		status, count              int
		requestID                  uint64
		decodeError                bool
	}{
		{name: "success", body: `{"ok":true,"data":[{"username":"alice"}],"revision":"r1"}`, status: 200, count: 1, revision: "r1"},
		{name: "success outside 2xx", body: `{"ok":true,"data":[{"username":"alice"}],"revision":"r2"}`, status: 503, count: 1, revision: "r2"},
		{name: "flat legacy", body: `[{"username":"alice"}]`, status: 200, count: 1},
		{name: "empty", body: `{"ok":true,"data":[]}`, status: 200},
		{name: "null", body: `{"ok":true,"data":null}`, status: 200},
		{name: "missing data", body: `{"ok":true}`, status: 200, decodeError: true},
		{name: "invalid error field", body: `{"ok":true,"data":[],"error":1}`, status: 200, decodeError: true},
		{name: "invalid request id", body: `{"ok":true,"data":[],"request_id":"bad"}`, status: 200, decodeError: true},
		{name: "API error", body: `{"ok":false,"error":{"code":"denied","message":"no"},"request_id":42}`, status: 403, code: "denied", requestID: 42},
		{name: "error with invalid data", body: `{"ok":false,"data":1,"error":{"code":"denied","message":"no"}}`, status: 403, code: "denied"},
		{name: "http error", body: `not JSON`, status: 502, code: "http_error"},
		{name: "invalid success payload", body: `{"ok":true,"data":1}`, status: 200, decodeError: true},
		{name: "invalid JSON", body: `{"ok":true,"data":[`, status: 200, decodeError: true},
		{name: "duplicate data last wins", body: `{"ok":true,"data":1,"data":[{"username":"alice"}],"revision":"r3"}`, status: 200, count: 1, revision: "r3"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if r.URL.Path != "/v1/users" || r.Header.Get("Authorization") != "Bearer fixture" {
					t.Error("request contract changed")
				}
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			users, revision, err := New(server.URL, "Bearer fixture").UsersWithRevision(context.Background())
			if requests.Load() != 1 {
				t.Fatal("fallback repeated the request")
			}
			if tc.code != "" {
				var apiError *APIError
				if !errors.As(err, &apiError) || apiError.Code != tc.code || apiError.Status != tc.status || apiError.RequestID != tc.requestID {
					t.Fatalf("API error changed: %v", err)
				}
				return
			}
			if tc.decodeError {
				if err == nil || !strings.Contains(err.Error(), "decode /v1/users:") {
					t.Fatalf("decode error changed: %v", err)
				}
				return
			}
			if err != nil || users == nil || len(users) != tc.count || revision != tc.revision {
				t.Fatalf("users=%v revision=%q err=%v", users, revision, err)
			}
		})
	}
}
