// Package telemt is a typed client for the Telemt control API.
// Unlike the 0.x panel's blind reverse proxy, every endpoint the panel uses
// has a typed method here, the {ok,data,revision} envelope is handled in one
// place, and capability differences between Telemt builds surface as typed
// errors instead of leaking to the browser.
package telemt

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// APIError is a non-2xx Telemt response decoded from the error envelope.
type APIError struct {
	Status    int
	Code      string
	Message   string
	RequestID uint64
}

func (e *APIError) Error() string {
	return fmt.Sprintf("telemt api: %s (%s, HTTP %d)", e.Message, e.Code, e.Status)
}

// Client talks to one Telemt instance.
type Client struct {
	baseURL    string
	authHeader string
	http       *http.Client
}

// New creates a client for the given API base URL (no trailing slash).
// authHeader is sent verbatim as the Authorization header; empty disables it.
func New(baseURL, authHeader string) *Client {
	return &Client{
		baseURL:    baseURL,
		authHeader: authHeader,
		http:       &http.Client{Timeout: 15 * time.Second},
	}
}

// envelope is Telemt's native success wrapper; revision is present on every
// successful response (hash of the canonical config manifest).
type envelope struct {
	OK       bool            `json:"ok"`
	Data     json.RawMessage `json:"data"`
	Revision string          `json:"revision"`
	Error    *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
	RequestID uint64 `json:"request_id"`
}

// call performs a request and returns the raw data payload plus revision.
func (c *Client) call(ctx context.Context, method, path string, body any) (json.RawMessage, string, error) {
	var reqBody io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return nil, "", fmt.Errorf("telemt: marshal request: %w", err)
		}
		reqBody = bytes.NewReader(buf)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reqBody)
	if err != nil {
		return nil, "", err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.authHeader != "" {
		req.Header.Set("Authorization", c.authHeader)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("telemt: %w", err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, "", fmt.Errorf("telemt: read response: %w", err)
	}

	var env envelope
	jsonErr := json.Unmarshal(raw, &env)
	switch {
	case jsonErr == nil && env.Error != nil:
		return nil, "", &APIError{Status: resp.StatusCode, Code: env.Error.Code, Message: env.Error.Message, RequestID: env.RequestID}
	case resp.StatusCode < 200 || resp.StatusCode >= 300:
		return nil, "", &APIError{Status: resp.StatusCode, Code: "http_error", Message: http.StatusText(resp.StatusCode)}
	case jsonErr == nil && env.OK:
		return env.Data, env.Revision, nil
	default:
		// Legacy builds return some payloads flat, without the envelope
		// (2xx, valid or invalid JSON for the envelope shape either way).
		return raw, "", nil
	}
}

// get decodes a GET response payload into T.
func get[T any](ctx context.Context, c *Client, path string) (T, error) {
	var out T
	data, _, err := c.call(ctx, http.MethodGet, path, nil)
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return out, fmt.Errorf("telemt: decode %s: %w", path, err)
	}
	return out, nil
}

// mutate performs a mutating request (POST/PATCH/DELETE) and decodes its
// payload into T. call already treats any 2xx status (200/201/202 — Telemt
// varies these across user-mutation endpoints depending on whether the
// change lands synchronously or via the config-file watcher) as success;
// this adds payload decoding, tolerating an empty body for mutations with
// nothing to report.
func mutate[T any](ctx context.Context, c *Client, method, path string, body any) (T, error) {
	var out T
	data, _, err := c.call(ctx, method, path, body)
	if err != nil {
		return out, err
	}
	if len(data) == 0 {
		return out, nil
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return out, fmt.Errorf("telemt: decode %s: %w", path, err)
	}
	return out, nil
}

// userSecret is the wire shape shared by CreateUser and RotateSecret: the
// resulting user plus its secret, returned exactly once.
type userSecret struct {
	User   UserInfo `json:"user"`
	Secret string   `json:"secret"`
}

// Health calls GET /v1/health.
func (c *Client) Health(ctx context.Context) (HealthData, error) {
	return get[HealthData](ctx, c, "/v1/health")
}

// SystemInfo calls GET /v1/system/info. Works with both enveloped and
// legacy flat responses (call already falls back to the raw body).
func (c *Client) SystemInfo(ctx context.Context) (SystemInfoData, error) {
	return get[SystemInfoData](ctx, c, "/v1/system/info")
}

// Users calls GET /v1/users.
func (c *Client) Users(ctx context.Context) ([]UserInfo, error) {
	return get[[]UserInfo](ctx, c, "/v1/users")
}

// StatsSummary calls GET /v1/stats/summary.
func (c *Client) StatsSummary(ctx context.Context) (SummaryData, error) {
	return get[SummaryData](ctx, c, "/v1/stats/summary")
}

// QuotaList calls GET /v1/stats/users/quota, keyed by username. A 404
// (not_found) means this Telemt build predates the endpoint; that is
// reported as a false capability flag, not an error, so callers can degrade
// gracefully instead of failing the whole request.
func (c *Client) QuotaList(ctx context.Context) (map[string]QuotaEntry, bool, error) {
	data, _, err := c.call(ctx, http.MethodGet, "/v1/stats/users/quota", nil)
	if err != nil {
		var apiErr *APIError
		if errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound {
			return nil, false, nil
		}
		return nil, false, err
	}
	var out map[string]QuotaEntry
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, false, fmt.Errorf("telemt: decode quota list: %w", err)
	}
	return out, true, nil
}

// CreateUser calls POST /v1/users. 409 user_exists surfaces as an *APIError.
func (c *Client) CreateUser(ctx context.Context, req CreateUserRequest) (UserInfo, string, error) {
	out, err := mutate[userSecret](ctx, c, http.MethodPost, "/v1/users", req)
	if err != nil {
		return UserInfo{}, "", err
	}
	return out.User, out.Secret, nil
}

// PatchUser calls PATCH /v1/users/{username} with a caller-built JSON Merge
// Patch map: a key absent from patch is omitted from the request body
// (Telemt: leave unchanged); a key present with a nil value marshals to
// JSON null (Telemt: remove the limit). Building that distinction is the
// caller's job — see httpapi's decodeUserPatch.
func (c *Client) PatchUser(ctx context.Context, username string, patch map[string]any) (UserInfo, error) {
	return mutate[UserInfo](ctx, c, http.MethodPatch, "/v1/users/"+url.PathEscape(username), patch)
}

// DeleteUser calls DELETE /v1/users/{username}. 409 last_user_forbidden
// surfaces as an *APIError when username is the last configured user.
func (c *Client) DeleteUser(ctx context.Context, username string) error {
	_, _, err := c.call(ctx, http.MethodDelete, "/v1/users/"+url.PathEscape(username), nil)
	return err
}

// ResetQuota calls POST /v1/users/{username}/reset-quota. The response
// carries only used_bytes (zeroed) and last_reset_epoch_secs — the
// resulting QuotaEntry's DataQuotaBytes is left at its zero value, since
// Telemt does not echo the configured limit back on this endpoint.
func (c *Client) ResetQuota(ctx context.Context, username string) (QuotaEntry, error) {
	return mutate[QuotaEntry](ctx, c, http.MethodPost, "/v1/users/"+url.PathEscape(username)+"/reset-quota", nil)
}

// RotateSecret calls POST /v1/users/{username}/rotate-secret, returning the
// new secret exactly once. On Telemt builds that predate this route, the
// request 404s/405s as an *APIError the caller maps to capability_absent.
func (c *Client) RotateSecret(ctx context.Context, username string) (UserInfo, string, error) {
	out, err := mutate[userSecret](ctx, c, http.MethodPost, "/v1/users/"+url.PathEscape(username)+"/rotate-secret", nil)
	if err != nil {
		return UserInfo{}, "", err
	}
	return out.User, out.Secret, nil
}

// SetEnabled calls POST /v1/users/{username}/enable or .../disable. On
// Telemt builds that predate these routes, the request 404s/405s as an
// *APIError the caller maps to capability_absent.
func (c *Client) SetEnabled(ctx context.Context, username string, enabled bool) (UserInfo, error) {
	action := "disable"
	if enabled {
		action = "enable"
	}
	return mutate[UserInfo](ctx, c, http.MethodPost, "/v1/users/"+url.PathEscape(username)+"/"+action, nil)
}
