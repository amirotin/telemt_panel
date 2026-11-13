package telemt

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type contractTransport func(*http.Request) string

func (f contractTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(f(r))), Header: make(http.Header)}, nil
}
func contractClient(body func(*http.Request) string) *Client {
	c := New("http://contract.invalid", "")
	c.http.Transport = contractTransport(body)
	c.now = func() time.Time { return time.Date(2026, 11, 11, 0, 0, 0, 0, time.UTC) }
	return c
}
func contractEnvelope(data string) string {
	return `{"ok":true,"revision":"source-2","data":` + data + `}`
}
func contractDrop(data, key string) string {
	var fields map[string]json.RawMessage
	json.Unmarshal([]byte(data), &fields)
	delete(fields, key)
	out, _ := json.Marshal(fields)
	return string(out)
}

const contractPolicy = `{"desired":{"user_max_tcp_conns_global_each":0,"user_max_unique_ips_global_each":0,"user_max_unique_ips_mode":"active_window","user_max_unique_ips_window_secs":0,"cidr_rate_limits":{}},"effective":{"user_max_tcp_conns_global_each":0,"user_max_unique_ips_global_each":0,"user_max_unique_ips_mode":"active_window","user_max_unique_ips_window_secs":0,"cidr_rate_limits":{}},"runtime":{"active_generation":0,"config_epoch":0,"runtime_match":"runtime:0:0"},"published_match":false,"effective_scope":"active_config_snapshot","subsystem_convergence":"unknown","apply_mode":"watcher","future":true}`
const contractDiscovery = `{"api_version":"v1","schema_version":1,"software_version":"3.5.17","config_schema":"/v1/config/schema","read_only":false,"availability_scope":"feature_and_runtime_source_prerequisites_not_request_success","operations":[{"method":"GET","path":"/v1/config/state","supported":true,"enabled":true}]}`
const contractSchema = `{"schema_version":1,"value_schema_dialect":"https://json-schema.org/draft/2020-12/schema","defaults_scope":"unconfigured_type_defaults_before_loader_normalization","validation_scope":"field_constraints_not_full_candidate_validation","path_notation":"dot_and_brackets","config_patch":{"objects":"merge","arrays":"replace","object_null_members":"ignored","reset":"not_supported","source_ownership":"main_source_only","if_match":"optional"},"fields":[]}`

func TestIncompleteMutationConfirmation(t *testing.T) {
	ctx := context.Background()
	cases := map[string]func(*Client) error{
		"create":  func(c *Client) error { _, _, e := c.CreateUser(ctx, CreateUserRequest{Username: "alice"}); return e },
		"patch":   func(c *Client) error { _, e := c.PatchUser(ctx, "alice", map[string]any{"enabled": false}); return e },
		"rotate":  func(c *Client) error { _, _, e := c.RotateSecret(ctx, "alice"); return e },
		"enable":  func(c *Client) error { _, e := c.SetEnabled(ctx, "alice", true); return e },
		"disable": func(c *Client) error { _, e := c.SetEnabled(ctx, "alice", false); return e },
		"reload":  func(c *Client) error { _, _, e := c.Reload(ctx, ReloadRequest{}, "source-1"); return e },
		"config": func(c *Client) error {
			_, _, _, e := c.PatchConfigRuntime(ctx, map[string]any{"general": map[string]any{"ntp_check": true}}, "source-1", "runtime-1", ReloadQuery{})
			return e
		},
		"quota":          func(c *Client) error { _, e := c.ResetQuota(ctx, "alice"); return e },
		"quota_revision": func(c *Client) error { _, e := c.ResetQuotaWithRevision(ctx, "alice", "source-1"); return e },
	}
	for name, call := range cases {
		t.Run(name, func(t *testing.T) {
			for _, payload := range []string{`{}`, `null`} {
				reads := 0
				c := contractClient(func(*http.Request) string { reads++; return contractEnvelope(payload) })
				if err := call(c); !errors.Is(err, ErrInvalidResponse) {
					t.Errorf("data=%s: got %v, want invalid response", payload, err)
				}
				if reads != 1 {
					t.Fatalf("uncertain mutation repeated %d times", reads)
				}
			}
		})
	}
}

func TestMutationRequiredFieldsAndLegacySuccess(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name, data string
		call       func(*Client) error
		required   []string
	}{
		{"create", `{"user":{"username":"alice"},"secret":"abc","future":true}`, func(c *Client) error { _, _, e := c.CreateUser(ctx, CreateUserRequest{Username: "alice"}); return e }, []string{"user", "secret"}},
		{"rotate", `{"user":{"username":"alice"},"secret":"abc"}`, func(c *Client) error { _, _, e := c.RotateSecret(ctx, "alice"); return e }, []string{"user", "secret"}},
		{"patch", `{"username":"alice"}`, func(c *Client) error { _, e := c.PatchUser(ctx, "alice", map[string]any{"max_tcp_conns": 0}); return e }, []string{"username"}},
		{"disable", `{"username":"alice","enabled":false}`, func(c *Client) error { _, e := c.SetEnabled(ctx, "alice", false); return e }, []string{"username", "enabled"}},
		{"quota", `{"used_bytes":0,"last_reset_epoch_secs":0}`, func(c *Client) error { _, e := c.ResetQuota(ctx, "alice"); return e }, []string{"used_bytes", "last_reset_epoch_secs"}},
		{"reload", `{"reload_id":1,"config_revision":"source-2","state":"accepted"}`, func(c *Client) error { _, _, e := c.Reload(ctx, ReloadRequest{}, ""); return e }, []string{"reload_id", "config_revision", "state"}},
		{"config", `{"revision":"source-2"}`, func(c *Client) error { _, _, _, e := c.PatchConfig(ctx, nil, "", ReloadQuery{}); return e }, []string{"revision"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for _, wire := range []string{tc.data, contractEnvelope(tc.data)} {
				c := contractClient(func(*http.Request) string { return wire })
				if err := tc.call(c); err != nil {
					t.Fatalf("valid native/flat result: %v", err)
				}
			}
			for _, key := range tc.required {
				for _, v := range []string{"", `null`} {
					data := contractDrop(tc.data, key)
					if v != "" {
						var fields map[string]json.RawMessage
						json.Unmarshal([]byte(data), &fields)
						fields[key] = json.RawMessage(v)
						raw, _ := json.Marshal(fields)
						data = string(raw)
					}
					c := contractClient(func(*http.Request) string { return contractEnvelope(data) })
					if err := tc.call(c); !errors.Is(err, ErrInvalidResponse) {
						t.Errorf("%s=%q accepted: %v", key, v, err)
					}
				}
			}
		})
	}
	for _, data := range []string{`{}`, `[]`, contractEnvelope(`{}`), contractEnvelope(`[]`)} {
		c := contractClient(func(*http.Request) string { return data })
		if err := c.DeleteUser(ctx, "alice"); err != nil {
			t.Errorf("legacy delete %s: %v", data, err)
		}
	}
	for _, data := range []string{`{"username":"other","enabled":true}`, `{"username":"alice","enabled":false}`} {
		c := contractClient(func(*http.Request) string { return contractEnvelope(data) })
		if _, err := c.SetEnabled(ctx, "alice", true); !errors.Is(err, ErrInvalidResponse) {
			t.Errorf("enable mismatch accepted %s: %v", data, err)
		}
	}
}

func TestPolicyRequiredResponseContract(t *testing.T) {
	ctx := context.Background()
	calls := map[string]func(*Client) error{"GET": func(c *Client) error { _, _, e := c.AccessPolicy(ctx); return e }, "PATCH": func(c *Client) error {
		_, _, e := c.PatchAccessPolicy(ctx, AccessPolicyPatch{"user_max_tcp_conns_global_each": json.RawMessage(`0`)}, "source-1", "runtime-1")
		return e
	}}
	invalid := []string{`{}`, `null`}
	for _, key := range []string{"desired", "effective", "runtime", "published_match", "effective_scope", "subsystem_convergence", "apply_mode"} {
		invalid = append(invalid, contractDrop(contractPolicy, key))
	}
	var full map[string]json.RawMessage
	json.Unmarshal([]byte(contractPolicy), &full)
	for _, section := range []string{"desired", "effective", "runtime"} {
		var fields map[string]json.RawMessage
		json.Unmarshal(full[section], &fields)
		for key := range fields {
			for _, replacement := range []string{"", `null`} {
				var copyFields map[string]json.RawMessage
				json.Unmarshal(full[section], &copyFields)
				delete(copyFields, key)
				if replacement != "" {
					copyFields[key] = json.RawMessage(replacement)
				}
				sectionData, _ := json.Marshal(copyFields)
				var copyFull map[string]json.RawMessage
				json.Unmarshal([]byte(contractPolicy), &copyFull)
				copyFull[section] = sectionData
				raw, _ := json.Marshal(copyFull)
				invalid = append(invalid, string(raw))
			}
		}
	}
	for name, call := range calls {
		t.Run(name, func(t *testing.T) {
			c := contractClient(func(*http.Request) string { return contractEnvelope(contractPolicy) })
			if err := call(c); err != nil {
				t.Fatalf("valid zero/false/empty-map policy: %v", err)
			}
			for i, data := range invalid {
				c := contractClient(func(*http.Request) string { return contractEnvelope(data) })
				if err := call(c); !errors.Is(err, ErrInvalidResponse) {
					t.Errorf("invalid %d accepted: %s: %v", i, data, err)
				}
			}
			c = contractClient(func(*http.Request) string { return `{"ok":true,"data":` + contractPolicy + `}` })
			if err := call(c); !errors.Is(err, ErrInvalidResponse) {
				t.Errorf("missing revision: %v", err)
			}
		})
	}
}

func TestMalformedMetadataRecoversAtFixedTime(t *testing.T) {
	ctx := context.Background()
	for _, kind := range []string{"discovery", "schema"} {
		valid := contractDiscovery
		collection := "operations"
		if kind == "schema" {
			valid = contractSchema
			collection = "fields"
		}
		invalid := []string{`{}`, `null`, `{"schema_version":1}`, contractDrop(valid, "schema_version"), contractDrop(valid, collection)}
		var complete map[string]json.RawMessage
		json.Unmarshal([]byte(valid), &complete)
		for key := range complete {
			invalid = append(invalid, contractDrop(valid, key))
		}
		if kind == "discovery" {
			for _, op := range []string{`{}`, `{"method":"GET","path":"/v1/config/state","supported":true}`, `null`} {
				changed := strings.Replace(valid, `[{"method":"GET","path":"/v1/config/state","supported":true,"enabled":true}]`, `[`+op+`]`, 1)
				invalid = append(invalid, changed)
			}
		} else {
			invalid = append(invalid, strings.Replace(valid, `"fields":[]`, `"fields":[{"path":"access.user_source_deny"}]`, 1))
		}
		for _, data := range invalid {
			t.Run(kind+data, func(t *testing.T) {
				bad := true
				reads := 0
				c := contractClient(func(r *http.Request) string {
					if r.URL.Path == "/v1/capabilities" {
						if kind == "discovery" {
							reads++
							if bad {
								return contractEnvelope(data)
							}
						}
						return contractEnvelope(contractDiscovery)
					}
					if r.URL.Path == "/v1/config/schema" {
						if kind == "schema" {
							reads++
							if bad {
								return contractEnvelope(data)
							}
						}
						return contractEnvelope(contractSchema)
					}
					return `{}`
				})
				if kind == "discovery" {
					if _, err := c.Discovery(ctx); !errors.Is(err, ErrInvalidResponse) {
						t.Errorf("malformed discovery accepted: %v", err)
					}
					c.Capabilities(ctx)
					bad = false
					caps, _ := c.Capabilities(ctx)
					if !caps.ConfigState {
						t.Error("malformed discovery cached as absent")
					}
				} else {
					if _, err := c.ConfigSchema(ctx); !errors.Is(err, ErrInvalidResponse) {
						t.Errorf("malformed schema accepted: %v", err)
					}
					bad = false
					if v, err := c.ConfigSchema(ctx); err != nil || v.SchemaVersion != 1 {
						t.Errorf("schema did not recover: %+v %v", v, err)
					}
				}
				if reads < 2 {
					t.Errorf("no recovery request: %d", reads)
				}
			})
		}
	}
	empty := strings.Replace(contractDiscovery, `[{"method":"GET","path":"/v1/config/state","supported":true,"enabled":true}]`, `[]`, 1)
	c := contractClient(func(*http.Request) string { return contractEnvelope(empty) })
	if _, err := c.Discovery(ctx); err != nil {
		t.Errorf("empty operations: %v", err)
	}
}

func TestMalformedMetadataRemainsUnknown(t *testing.T) {
	for _, path := range []string{"/v1/capabilities", "/v1/config/schema"} {
		t.Run(path, func(t *testing.T) {
			bad := true
			c := contractClient(func(r *http.Request) string {
				if bad && r.URL.Path == path {
					return contractEnvelope(`{}`)
				}
				switch r.URL.Path {
				case "/v1/capabilities":
					return contractEnvelope(contractDiscovery)
				case "/v1/config/schema":
					return contractEnvelope(contractSchema)
				}
				return `{}`
			})
			ctx := context.Background()
			caps, err := c.Capabilities(ctx)
			if err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(caps)
			var flags map[string]bool
			json.Unmarshal(raw, &flags)
			if !flags["optional_metadata_unavailable"] {
				t.Errorf("malformed metadata presented as definite absence: %s", raw)
			}
			bad = false
			caps, err = c.Capabilities(ctx)
			if err != nil || !caps.ConfigState {
				t.Fatalf("did not recover: %+v %v", caps, err)
			}
			raw, _ = json.Marshal(caps)
			json.Unmarshal(raw, &flags)
			if strings.Contains(string(raw), `"optional_metadata_unavailable":true`) {
				t.Errorf("error status retained after recovery: %s", raw)
			}
		})
	}
}

func TestPatchUserNamedLikeAnAction(t *testing.T) {
	for _, username := range []string{"enable", "disable"} {
		c := contractClient(func(*http.Request) string { return contractEnvelope(`{"username":"` + username + `"}`) })
		if _, err := c.PatchUser(context.Background(), username, map[string]any{"max_tcp_conns": 0}); err != nil {
			t.Errorf("username %s: %v", username, err)
		}
	}
}
