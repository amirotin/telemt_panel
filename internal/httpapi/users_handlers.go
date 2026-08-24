package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/subpage"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

// maxUserPatchBody bounds the PATCH /api/users/{username} request body —
// well above any legitimate patch, just enough to stop an abusive caller
// from streaming an unbounded body into json.Unmarshal.
const maxUserPatchBody = 64 << 10

// userQuota mirrors api/openapi.yaml User.quota: present only when the
// quota capability is available on this Telemt build and the user has an
// entry in the quota list.
type userQuota struct {
	UsedBytes          uint64 `json:"used_bytes"`
	LastResetEpochSecs int64  `json:"last_reset_epoch_secs"`
}

// userResponse mirrors api/openapi.yaml schema User: Telemt's UserInfo
// merged with quota usage and the panel's sub_url extra.
type userResponse struct {
	Username            string           `json:"username"`
	Enabled             bool             `json:"enabled"`
	InRuntime           bool             `json:"in_runtime"`
	UserAdTag           string           `json:"user_ad_tag,omitempty"`
	MaxTCPConns         *uint64          `json:"max_tcp_conns,omitempty"`
	MaxUniqueIPs        *uint64          `json:"max_unique_ips,omitempty"`
	DataQuotaBytes      *uint64          `json:"data_quota_bytes,omitempty"`
	ExpirationRFC3339   string           `json:"expiration_rfc3339,omitempty"`
	RateLimitUpBps      *uint64          `json:"rate_limit_up_bps,omitempty"`
	RateLimitDownBps    *uint64          `json:"rate_limit_down_bps,omitempty"`
	CurrentConnections  uint64           `json:"current_connections"`
	ActiveUniqueIPs     uint64           `json:"active_unique_ips"`
	ActiveUniqueIPsList []string         `json:"active_unique_ips_list"`
	RecentUniqueIPs     uint64           `json:"recent_unique_ips"`
	RecentUniqueIPsList []string         `json:"recent_unique_ips_list"`
	TotalOctets         uint64           `json:"total_octets"`
	Links               telemt.UserLinks `json:"links"`
	Quota               *userQuota       `json:"quota,omitempty"`
	SubURL              string           `json:"sub_url,omitempty"`
}

// userSecretResponse mirrors the {user, secret} response shape shared by
// POST /api/users and POST /api/users/{username}/rotate-secret.
type userSecretResponse struct {
	User   userResponse `json:"user"`
	Secret string       `json:"secret"`
}

// buildUserResponse assembles the composite User response for u: quota
// usage from quota (when hasQuota and u has an entry) and sub_url (when
// the subpage module is enabled and a link secret can be extracted). A
// failure to build sub_url — a store error reading the nonce — is logged
// and the field is simply omitted; it must never turn an otherwise
// successful users read into an error.
func (s *Server) buildUserResponse(r *http.Request, u telemt.UserInfo, quota map[string]telemt.QuotaEntry, hasQuota bool) userResponse {
	resp := userResponse{
		Username:            u.Username,
		Enabled:             u.Enabled,
		InRuntime:           u.InRuntime,
		UserAdTag:           u.UserAdTag,
		MaxTCPConns:         u.MaxTCPConns,
		MaxUniqueIPs:        u.MaxUniqueIPs,
		DataQuotaBytes:      u.DataQuotaBytes,
		ExpirationRFC3339:   u.ExpirationRFC3339,
		RateLimitUpBps:      u.RateLimitUpBps,
		RateLimitDownBps:    u.RateLimitDownBps,
		CurrentConnections:  u.CurrentConnections,
		ActiveUniqueIPs:     u.ActiveUniqueIPs,
		ActiveUniqueIPsList: u.ActiveIPList,
		RecentUniqueIPs:     u.RecentUniqueIPs,
		RecentUniqueIPsList: u.RecentIPList,
		TotalOctets:         u.TotalOctets,
		Links:               u.Links,
	}
	if hasQuota {
		if q, ok := quota[u.Username]; ok {
			resp.Quota = &userQuota{UsedBytes: q.UsedBytes, LastResetEpochSecs: q.LastResetEpochSecs}
		}
	}
	if s.cfg.Subpage.Enabled {
		if secret, ok := subpage.ExtractSecret(u.Links); ok {
			if path, err := s.subSvc.URL(u.Username, secret); err == nil {
				resp.SubURL = absoluteURL(r, s.cfg, path)
			} else {
				slog.Warn("users: build sub_url", "username", u.Username, "err", err)
			}
		}
	}
	return resp
}

// quotaListOrDegrade calls QuotaList and, on error, logs and reports the
// capability as absent rather than failing the caller's request — a
// composite users response should still render without quota data rather
// than 502ing outright over a hiccup in one merge input.
func (s *Server) quotaListOrDegrade(ctx context.Context) (map[string]telemt.QuotaEntry, bool) {
	quota, hasQuota, err := s.tc.QuotaList(ctx)
	if err != nil {
		slog.Warn("users: quota list", "err", err)
		return nil, false
	}
	return quota, hasQuota
}

// handleListUsers implements GET /api/users.
func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), subpageRequestTimeout)
	defer cancel()

	users, err := s.tc.Users(ctx)
	if err != nil {
		writeTelemtError(w, err, false)
		return
	}
	quota, hasQuota := s.quotaListOrDegrade(ctx)

	out := make([]userResponse, len(users))
	for i, u := range users {
		out[i] = s.buildUserResponse(r, u, quota, hasQuota)
	}
	writeJSON(w, http.StatusOK, out)
}

// handleCreateUser implements POST /api/users.
func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	var req telemt.CreateUserRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxUserPatchBody)).Decode(&req); err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "invalid request body")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), subpageRequestTimeout)
	defer cancel()

	u, secret, err := s.tc.CreateUser(ctx, req)
	if err != nil {
		writeTelemtError(w, err, false)
		return
	}
	s.appendAudit("user.create", u.Username, "")

	quota, hasQuota := s.quotaListOrDegrade(ctx)
	writeJSON(w, http.StatusCreated, userSecretResponse{
		User:   s.buildUserResponse(r, u, quota, hasQuota),
		Secret: secret,
	})
}

// handleGetUser implements GET /api/users/{username}.
func (s *Server) handleGetUser(w http.ResponseWriter, r *http.Request) {
	username := r.PathValue("username")

	ctx, cancel := context.WithTimeout(r.Context(), subpageRequestTimeout)
	defer cancel()

	users, err := s.tc.Users(ctx)
	if err != nil {
		writeTelemtError(w, err, false)
		return
	}
	u, ok := findUser(users, username)
	if !ok {
		auth.WriteError(w, http.StatusNotFound, "not_found", "user not found")
		return
	}
	quota, hasQuota := s.quotaListOrDegrade(ctx)
	writeJSON(w, http.StatusOK, s.buildUserResponse(r, u, quota, hasQuota))
}

// handlePatchUser implements PATCH /api/users/{username}.
func (s *Server) handlePatchUser(w http.ResponseWriter, r *http.Request) {
	username := r.PathValue("username")

	body, err := io.ReadAll(io.LimitReader(r.Body, maxUserPatchBody))
	if err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "could not read request body")
		return
	}
	patch, err := decodeUserPatch(body)
	if err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "invalid request body")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), subpageRequestTimeout)
	defer cancel()

	u, err := s.tc.PatchUser(ctx, username, patch)
	if err != nil {
		writeTelemtError(w, err, false)
		return
	}
	s.appendAudit("user.patch", username, "")

	quota, hasQuota := s.quotaListOrDegrade(ctx)
	writeJSON(w, http.StatusOK, s.buildUserResponse(r, u, quota, hasQuota))
}

// handleDeleteUser implements DELETE /api/users/{username}.
func (s *Server) handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	username := r.PathValue("username")

	ctx, cancel := context.WithTimeout(r.Context(), subpageRequestTimeout)
	defer cancel()

	if err := s.tc.DeleteUser(ctx, username); err != nil {
		writeTelemtError(w, err, false)
		return
	}
	s.appendAudit("user.delete", username, "")
	w.WriteHeader(http.StatusNoContent)
}

// handleResetQuota implements POST /api/users/{username}/reset-quota.
func (s *Server) handleResetQuota(w http.ResponseWriter, r *http.Request) {
	username := r.PathValue("username")

	ctx, cancel := context.WithTimeout(r.Context(), subpageRequestTimeout)
	defer cancel()

	q, err := s.tc.ResetQuota(ctx, username)
	if err != nil {
		writeTelemtError(w, err, false)
		return
	}
	s.appendAudit("quota.reset", username, "")

	writeJSON(w, http.StatusOK, struct {
		Username           string `json:"username"`
		UsedBytes          uint64 `json:"used_bytes"`
		LastResetEpochSecs int64  `json:"last_reset_epoch_secs"`
	}{Username: username, UsedBytes: q.UsedBytes, LastResetEpochSecs: q.LastResetEpochSecs})
}

// handleRotateSecret implements POST /api/users/{username}/rotate-secret.
// capabilityGated=true: older Telemt builds may not register this route at
// all, which writeTelemtError reports as 501 capability_absent rather than
// 404 not_found.
func (s *Server) handleRotateSecret(w http.ResponseWriter, r *http.Request) {
	username := r.PathValue("username")

	ctx, cancel := context.WithTimeout(r.Context(), subpageRequestTimeout)
	defer cancel()

	u, secret, err := s.tc.RotateSecret(ctx, username)
	if err != nil {
		writeTelemtError(w, err, true)
		return
	}
	s.appendAudit("secret.rotate", username, "")

	quota, hasQuota := s.quotaListOrDegrade(ctx)
	writeJSON(w, http.StatusOK, userSecretResponse{
		User:   s.buildUserResponse(r, u, quota, hasQuota),
		Secret: secret,
	})
}

// handleSetEnabled implements PUT /api/users/{username}/enabled. openapi.yaml
// marks enabled required; decodeEnabledRequest rejects a body where the key
// is absent or explicitly null rather than silently defaulting to false.
func (s *Server) handleSetEnabled(w http.ResponseWriter, r *http.Request) {
	username := r.PathValue("username")

	body, err := io.ReadAll(io.LimitReader(r.Body, maxUserPatchBody))
	if err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "could not read request body")
		return
	}
	enabled, err := decodeEnabledRequest(body)
	if err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "enabled is required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), subpageRequestTimeout)
	defer cancel()

	u, err := s.tc.SetEnabled(ctx, username, enabled)
	if err != nil {
		writeTelemtError(w, err, true)
		return
	}
	s.appendAudit("user.enabled", username, fmt.Sprintf("enabled=%t", enabled))

	quota, hasQuota := s.quotaListOrDegrade(ctx)
	writeJSON(w, http.StatusOK, s.buildUserResponse(r, u, quota, hasQuota))
}

// decodeEnabledRequest parses the PUT /api/users/{username}/enabled body's
// required "enabled" key. An absent key or an explicit JSON null both
// error — encoding/json unmarshaling null into a plain bool is a silent
// no-op, not an error, so without this check a caller sending
// {"enabled":null} (or {}) would flip a user disabled with no signal.
func decodeEnabledRequest(body []byte) (bool, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return false, err
	}
	v, ok := raw["enabled"]
	if !ok || bytes.Equal(bytes.TrimSpace(v), jsonNull) {
		return false, errors.New("enabled is required")
	}
	var enabled bool
	if err := json.Unmarshal(v, &enabled); err != nil {
		return false, err
	}
	return enabled, nil
}

// userPatchFields is the set of keys accepted from a UserPatch request
// body, and how to decode each one's raw JSON value once it is known not
// to be an explicit null.
var userPatchFields = map[string]func(json.RawMessage) (any, error){
	"secret":              decodeStringPatchField,
	"user_ad_tag":         decodeStringPatchField,
	"max_tcp_conns":       decodeUint64PatchField,
	"max_unique_ips":      decodeUint64PatchField,
	"data_quota_bytes":    decodeUint64PatchField,
	"expiration_rfc3339":  decodeStringPatchField,
	"rate_limit_up_bps":   decodeUint64PatchField,
	"rate_limit_down_bps": decodeUint64PatchField,
	"enabled":             decodeBoolPatchField,
}

func decodeStringPatchField(v json.RawMessage) (any, error) {
	var s string
	err := json.Unmarshal(v, &s)
	return s, err
}

func decodeUint64PatchField(v json.RawMessage) (any, error) {
	var n uint64
	err := json.Unmarshal(v, &n)
	return n, err
}

func decodeBoolPatchField(v json.RawMessage) (any, error) {
	var b bool
	err := json.Unmarshal(v, &b)
	return b, err
}

// jsonNull is the exact byte sequence json.Marshal produces for a Go nil,
// used to detect an explicit JSON null in a raw field value.
var jsonNull = []byte("null")

// decodeUserPatch parses a UserPatch request body into a JSON Merge Patch
// map suitable for telemt.PatchUser: a key present in body with JSON null
// becomes an explicit nil entry (Telemt: remove the limit); a key absent
// from body is absent from the returned map, so PatchUser's request
// marshaling omits it entirely (Telemt: leave unchanged). This decodes via
// json.RawMessage per key rather than a typed struct, because a struct's
// pointer fields collapse "absent" and "null" to the same nil value —
// exactly the distinction that must survive onto the wire.
//
// secret is the one field this null handling does not apply to: both
// openapi.yaml (UserPatch.secret is a plain, non-nullable string) and
// 07-telemt-sdk.md ("secret non-nullable") forbid removing it via merge
// patch, so an explicit "secret":null is rejected here rather than
// forwarded upstream.
func decodeUserPatch(body []byte) (map[string]any, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}

	patch := make(map[string]any, len(raw))
	for key, val := range raw {
		decode, ok := userPatchFields[key]
		if !ok {
			continue // unknown fields ignored, matching Telemt's own tolerance
		}
		if bytes.Equal(bytes.TrimSpace(val), jsonNull) {
			if key == "secret" {
				return nil, errors.New("secret cannot be null")
			}
			patch[key] = nil
			continue
		}
		v, err := decode(val)
		if err != nil {
			return nil, err
		}
		patch[key] = v
	}
	return patch, nil
}

// writeTelemtError maps a telemt.APIError (or a plain transport failure) to
// the panel's {code, message} error envelope. capabilityGated marks
// endpoints — enable/disable, rotate-secret — that older Telemt builds may
// not register as routes at all: an unrouted request typically comes back
// as a bare, non-enveloped 404/405 (surfaced by the SDK as APIError with a
// generic code, not "not_found"), which this reports as 501
// capability_absent rather than 404. A well-formed not_found error (the
// route exists; the user genuinely doesn't) always maps to 404 regardless
// of capabilityGated, since that switch case is checked first.
//
// telemt_unreachable is reserved for actual connectivity failures (no
// *APIError at all) and for upstream 5xx/unexpected statuses. An *APIError
// whose code isn't one of the ones above but whose status is 4xx (e.g.
// bad_request, forbidden, revision_conflict) is the admin's own input being
// rejected, not the backend being unreachable — that must not be masked as
// 502 telemt_unreachable, so it passes through with Telemt's own status,
// code and message.
func writeTelemtError(w http.ResponseWriter, err error, capabilityGated bool) {
	var apiErr *telemt.APIError
	if !errors.As(err, &apiErr) {
		auth.WriteError(w, http.StatusBadGateway, "telemt_unreachable", "could not reach telemt")
		return
	}
	switch apiErr.Code {
	case "user_exists", "last_user_forbidden":
		auth.WriteError(w, http.StatusConflict, apiErr.Code, apiErr.Message)
	case "read_only":
		auth.WriteError(w, http.StatusForbidden, apiErr.Code, apiErr.Message)
	case "not_found":
		auth.WriteError(w, http.StatusNotFound, apiErr.Code, apiErr.Message)
	default:
		if capabilityGated && (apiErr.Status == http.StatusNotFound || apiErr.Status == http.StatusMethodNotAllowed) {
			auth.WriteError(w, http.StatusNotImplemented, "capability_absent", "telemt build does not support this operation")
			return
		}
		if apiErr.Status >= 400 && apiErr.Status < 500 {
			auth.WriteError(w, apiErr.Status, apiErr.Code, apiErr.Message)
			return
		}
		auth.WriteError(w, http.StatusBadGateway, "telemt_unreachable", apiErr.Message)
	}
}
