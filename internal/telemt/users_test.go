package telemt

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"testing"
)

func TestQuotaList(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/stats/users/quota" {
			t.Errorf("path = %s", r.URL.Path)
		}
		// Real wire shape (src/api/users/view.rs::build_user_quota_list):
		// an object with a users array, not a map keyed by username.
		w.Write([]byte(`{"ok":true,"data":{"users":[{"username":"alice","data_quota_bytes":1024,"used_bytes":512,"last_reset_epoch_secs":100}]},"revision":"r"}`))
	})

	quota, ok, err := c.QuotaList(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected capability present")
	}
	alice, present := quota["alice"]
	if !present || alice.DataQuotaBytes != 1024 || alice.UsedBytes != 512 || alice.LastResetEpochSecs != 100 {
		t.Errorf("quota[alice] = %+v", alice)
	}
}

func TestQuotaListCapabilityAbsent(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte("404 page not found"))
	})

	quota, ok, err := c.QuotaList(context.Background())
	if err != nil {
		t.Fatalf("expected nil error on capability-absent 404, got %v", err)
	}
	if ok {
		t.Fatal("expected capability absent")
	}
	if quota != nil {
		t.Errorf("quota = %+v, want nil", quota)
	}
}

func TestQuotaListJSONNotFoundAlsoCapabilityAbsent(t *testing.T) {
	// A build that does wrap this 404 in the standard envelope should be
	// treated identically to a raw, unrouted 404 — status is what matters.
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"ok":false,"error":{"code":"not_found","message":"no such route"},"request_id":1}`))
	})

	_, ok, err := c.QuotaList(context.Background())
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if ok {
		t.Fatal("expected capability absent")
	}
}

func TestQuotaListTransportErrorPropagates(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"ok":false,"error":{"code":"internal_error","message":"boom"},"request_id":1}`))
	})

	_, ok, err := c.QuotaList(context.Background())
	if err == nil {
		t.Fatal("expected an error for a non-404 failure")
	}
	if ok {
		t.Fatal("expected capability absent flag false on error")
	}
}

func TestCreateUser(t *testing.T) {
	var gotBody []byte
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/users" {
			t.Errorf("method/path = %s %s", r.Method, r.URL.Path)
		}
		buf, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read request body: %v", err)
		}
		gotBody = buf
		w.WriteHeader(http.StatusCreated)
		w.Write([]byte(`{"ok":true,"data":{"user":{"username":"bob","enabled":true,"in_runtime":false,
			"current_connections":0,"active_unique_ips":0,"active_unique_ips_list":[],
			"recent_unique_ips":0,"recent_unique_ips_list":[],"total_octets":0,
			"links":{"classic":[],"secure":[],"tls":[],"tls_domains":[]}},
			"secret":"deadbeefdeadbeefdeadbeefdeadbeef"},"revision":"r"}`))
	})

	u, secret, err := c.CreateUser(context.Background(), CreateUserRequest{Username: "bob"})
	if err != nil {
		t.Fatal(err)
	}
	if u.Username != "bob" || secret != "deadbeefdeadbeefdeadbeefdeadbeef" {
		t.Errorf("user = %+v secret = %q", u, secret)
	}
	var sent map[string]any
	if err := json.Unmarshal(gotBody, &sent); err != nil {
		t.Fatalf("decode sent body: %v", err)
	}
	if sent["username"] != "bob" {
		t.Errorf("sent body = %s", gotBody)
	}
	if _, present := sent["secret"]; present {
		t.Errorf("expected omitempty secret to be absent, got %s", gotBody)
	}
}

func TestCreateUserExists(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		w.Write([]byte(`{"ok":false,"error":{"code":"user_exists","message":"already exists"},"request_id":1}`))
	})

	_, _, err := c.CreateUser(context.Background(), CreateUserRequest{Username: "bob"})
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Code != "user_exists" || apiErr.Status != http.StatusConflict {
		t.Fatalf("err = %v", err)
	}
}

// TestPatchUserTriState asserts the exact JSON body sent upstream for the
// merge-patch tri-state: an omitted field must be absent from the outgoing
// object, a field set to nil must marshal to explicit JSON null, and a
// field set to a value must marshal to that value — three different byte
// sequences on the wire for what would otherwise collapse to the same Go
// zero value with a naive struct-based request.
func TestPatchUserTriState(t *testing.T) {
	var gotBody []byte
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch || r.URL.Path != "/v1/users/bob" {
			t.Errorf("method/path = %s %s", r.Method, r.URL.Path)
		}
		buf, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read request body: %v", err)
		}
		gotBody = buf
		w.Write([]byte(`{"ok":true,"data":{"username":"bob","enabled":true,"in_runtime":false,
			"current_connections":0,"active_unique_ips":0,"active_unique_ips_list":[],
			"recent_unique_ips":0,"recent_unique_ips_list":[],"total_octets":0,
			"links":{"classic":[],"secure":[],"tls":[],"tls_domains":[]}},"revision":"r"}`))
	})

	patch := map[string]any{
		"data_quota_bytes": uint64(2048), // set
		"max_tcp_conns":    nil,          // explicit remove
		// user_ad_tag: omitted entirely — leave unchanged
	}
	if _, err := c.PatchUser(context.Background(), "bob", patch); err != nil {
		t.Fatal(err)
	}

	const want = `{"data_quota_bytes":2048,"max_tcp_conns":null}`
	if string(gotBody) != want {
		t.Errorf("sent body = %s, want %s", gotBody, want)
	}
}

func TestPatchUserNotFound(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"ok":false,"error":{"code":"not_found","message":"no such user"},"request_id":1}`))
	})

	_, err := c.PatchUser(context.Background(), "ghost", map[string]any{"enabled": true})
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Code != "not_found" {
		t.Fatalf("err = %v", err)
	}
}

func TestDeleteUser(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/v1/users/bob" {
			t.Errorf("method/path = %s %s", r.Method, r.URL.Path)
		}
		w.Write([]byte(`{"ok":true,"data":{"username":"bob","in_runtime":false},"revision":"r"}`))
	})

	if err := c.DeleteUser(context.Background(), "bob"); err != nil {
		t.Fatal(err)
	}
}

func TestDeleteUserLastUserForbidden(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		w.Write([]byte(`{"ok":false,"error":{"code":"last_user_forbidden","message":"cannot delete last user"},"request_id":1}`))
	})

	err := c.DeleteUser(context.Background(), "bob")
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Code != "last_user_forbidden" {
		t.Fatalf("err = %v", err)
	}
}

func TestResetQuota(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/users/bob/reset-quota" {
			t.Errorf("method/path = %s %s", r.Method, r.URL.Path)
		}
		w.Write([]byte(`{"ok":true,"data":{"username":"bob","used_bytes":0,"last_reset_epoch_secs":1000},"revision":"r"}`))
	})

	q, err := c.ResetQuota(context.Background(), "bob")
	if err != nil {
		t.Fatal(err)
	}
	if q.UsedBytes != 0 || q.LastResetEpochSecs != 1000 {
		t.Errorf("quota = %+v", q)
	}
}

func TestRotateSecret(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/users/bob/rotate-secret" {
			t.Errorf("method/path = %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusAccepted)
		w.Write([]byte(`{"ok":true,"data":{"user":{"username":"bob","enabled":true,"in_runtime":true,
			"current_connections":0,"active_unique_ips":0,"active_unique_ips_list":[],
			"recent_unique_ips":0,"recent_unique_ips_list":[],"total_octets":0,
			"links":{"classic":[],"secure":[],"tls":[],"tls_domains":[]}},
			"secret":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"revision":"r"}`))
	})

	u, secret, err := c.RotateSecret(context.Background(), "bob")
	if err != nil {
		t.Fatal(err)
	}
	if u.Username != "bob" || secret != "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" {
		t.Errorf("user = %+v secret = %q", u, secret)
	}
}

func TestRotateSecretCapabilityAbsent(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte("404 page not found"))
	})

	_, _, err := c.RotateSecret(context.Background(), "bob")
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusNotFound {
		t.Fatalf("err = %v, want a 404 *APIError", err)
	}
}

func TestSetEnabled(t *testing.T) {
	var gotPath string
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusAccepted)
		w.Write([]byte(`{"ok":true,"data":{"username":"bob","enabled":false,"in_runtime":true,
			"current_connections":0,"active_unique_ips":0,"active_unique_ips_list":[],
			"recent_unique_ips":0,"recent_unique_ips_list":[],"total_octets":0,
			"links":{"classic":[],"secure":[],"tls":[],"tls_domains":[]}},"revision":"r"}`))
	})

	u, err := c.SetEnabled(context.Background(), "bob", false)
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/users/bob/disable" {
		t.Errorf("path = %s, want disable route", gotPath)
	}
	if u.Enabled {
		t.Errorf("user.Enabled = true, want false")
	}
}

func TestSetEnabledMethodNotAllowedIsAPIError(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusMethodNotAllowed)
		w.Write([]byte(`{"ok":false,"error":{"code":"method_not_allowed","message":"no such route"},"request_id":1}`))
	})

	_, err := c.SetEnabled(context.Background(), "bob", true)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusMethodNotAllowed {
		t.Fatalf("err = %v, want a 405 *APIError", err)
	}
}
