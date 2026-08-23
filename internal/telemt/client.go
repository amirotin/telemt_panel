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
	"fmt"
	"io"
	"net/http"
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
