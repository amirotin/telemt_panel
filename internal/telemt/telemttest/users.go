package telemttest

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

func (s *Server) handleUsersList(w http.ResponseWriter) {
	out := make([]telemt.UserInfo, 0, len(s.users))
	for _, u := range s.users {
		out = append(out, u)
	}
	writeOK(w, http.StatusOK, out, s.revision())
}

func (s *Server) handleGetUser(w http.ResponseWriter, username string) {
	u, ok := s.users[username]
	if !ok {
		writeErr(w, http.StatusNotFound, "not_found", "no such user")
		return
	}
	writeOK(w, http.StatusOK, u, s.revision())
}

func (s *Server) handleQuotaList(w http.ResponseWriter) {
	if s.scenario.OldBuild {
		writeBareNotFound(w)
		return
	}
	entries := make([]struct {
		Username           string `json:"username"`
		DataQuotaBytes     uint64 `json:"data_quota_bytes"`
		UsedBytes          uint64 `json:"used_bytes"`
		LastResetEpochSecs int64  `json:"last_reset_epoch_secs"`
	}, 0, len(s.quota))
	for username, q := range s.quota {
		entries = append(entries, struct {
			Username           string `json:"username"`
			DataQuotaBytes     uint64 `json:"data_quota_bytes"`
			UsedBytes          uint64 `json:"used_bytes"`
			LastResetEpochSecs int64  `json:"last_reset_epoch_secs"`
		}{username, q.DataQuotaBytes, q.UsedBytes, q.LastResetEpochSecs})
	}
	writeOK(w, http.StatusOK, struct {
		Users any `json:"users"`
	}{entries}, s.revision())
}

func (s *Server) handleActiveIPs(w http.ResponseWriter) {
	out := make([]telemt.UserActiveIps, 0, len(s.users))
	for username, u := range s.users {
		if len(u.ActiveIPList) == 0 {
			continue
		}
		out = append(out, telemt.UserActiveIps{Username: username, ActiveIPs: u.ActiveIPList})
	}
	writeOK(w, http.StatusOK, out, s.revision())
}

func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	if s.scenario.ReadOnly {
		writeReadOnly(w)
		return
	}
	var req telemt.CreateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return
	}
	if _, exists := s.users[req.Username]; exists {
		writeErr(w, http.StatusConflict, "user_exists", "already exists")
		return
	}
	secret := req.Secret
	if secret == "" {
		secret = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	u := telemt.UserInfo{
		Username: req.Username, Enabled: enabled, InRuntime: true,
		UserAdTag: req.UserAdTag, MaxTCPConns: req.MaxTCPConns,
		ExpirationRFC3339: req.ExpirationRFC3339, DataQuotaBytes: req.DataQuotaBytes,
		RateLimitUpBps: req.RateLimitUpBps, RateLimitDownBps: req.RateLimitDownBps,
		MaxUniqueIPs: req.MaxUniqueIPs,
		ActiveIPList: []string{}, RecentIPList: []string{},
		Links: telemt.UserLinks{Classic: []string{}, Secure: []string{}, TLS: []string{}, TLSDomains: []telemt.TLSDomainLink{}},
	}
	s.users[req.Username] = u
	s.secrets[req.Username] = secret
	writeOK(w, http.StatusCreated, struct {
		User   telemt.UserInfo `json:"user"`
		Secret string          `json:"secret"`
	}{u, secret}, s.bumpRevision())
}

func (s *Server) handlePatchUser(w http.ResponseWriter, r *http.Request, username string) {
	if s.scenario.ReadOnly {
		writeReadOnly(w)
		return
	}
	u, ok := s.users[username]
	if !ok {
		writeErr(w, http.StatusNotFound, "not_found", "no such user")
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid request body")
		return
	}
	var patch map[string]json.RawMessage
	if err := json.Unmarshal(body, &patch); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return
	}
	applyUint64Patch(patch, "data_quota_bytes", &u.DataQuotaBytes)
	applyUint64Patch(patch, "max_tcp_conns", &u.MaxTCPConns)
	applyUint64Patch(patch, "rate_limit_up_bps", &u.RateLimitUpBps)
	applyUint64Patch(patch, "rate_limit_down_bps", &u.RateLimitDownBps)
	applyUint64Patch(patch, "max_unique_ips", &u.MaxUniqueIPs)
	if raw, present := patch["user_ad_tag"]; present {
		if isJSONNull(raw) {
			u.UserAdTag = ""
		} else {
			_ = json.Unmarshal(raw, &u.UserAdTag)
		}
	}
	if raw, present := patch["expiration_rfc3339"]; present {
		if isJSONNull(raw) {
			u.ExpirationRFC3339 = ""
		} else {
			_ = json.Unmarshal(raw, &u.ExpirationRFC3339)
		}
	}
	if raw, present := patch["enabled"]; present && !isJSONNull(raw) {
		_ = json.Unmarshal(raw, &u.Enabled)
	}
	s.users[username] = u
	writeOK(w, http.StatusOK, u, s.bumpRevision())
}

func isJSONNull(raw json.RawMessage) bool {
	return string(raw) == "null"
}

func applyUint64Patch(patch map[string]json.RawMessage, key string, field **uint64) {
	raw, present := patch[key]
	if !present {
		return
	}
	if isJSONNull(raw) {
		*field = nil
		return
	}
	var v uint64
	if err := json.Unmarshal(raw, &v); err == nil {
		*field = &v
	}
}

func (s *Server) handleDeleteUser(w http.ResponseWriter, username string) {
	if s.scenario.ReadOnly {
		writeReadOnly(w)
		return
	}
	u, ok := s.users[username]
	if !ok {
		writeErr(w, http.StatusNotFound, "not_found", "no such user")
		return
	}
	if len(s.users) == 1 {
		writeErr(w, http.StatusConflict, "last_user_forbidden", "cannot delete last user")
		return
	}
	delete(s.users, username)
	delete(s.secrets, username)
	delete(s.quota, username)
	writeOK(w, http.StatusOK, struct {
		Username  string `json:"username"`
		InRuntime bool   `json:"in_runtime"`
	}{username, u.InRuntime}, s.bumpRevision())
}

func (s *Server) handleRotateSecret(w http.ResponseWriter, username string) {
	if s.scenario.ReadOnly {
		writeReadOnly(w)
		return
	}
	u, ok := s.users[username]
	if !ok {
		writeErr(w, http.StatusNotFound, "not_found", "no such user")
		return
	}
	secret := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	s.secrets[username] = secret
	writeOK(w, http.StatusAccepted, struct {
		User   telemt.UserInfo `json:"user"`
		Secret string          `json:"secret"`
	}{u, secret}, s.bumpRevision())
}

func (s *Server) handleSetEnabled(w http.ResponseWriter, username string, enabled bool) {
	if s.scenario.ReadOnly {
		writeReadOnly(w)
		return
	}
	u, ok := s.users[username]
	if !ok {
		writeErr(w, http.StatusNotFound, "not_found", "no such user")
		return
	}
	u.Enabled = enabled
	s.users[username] = u
	writeOK(w, http.StatusOK, u, s.bumpRevision())
}

func (s *Server) handleResetQuota(w http.ResponseWriter, username string) {
	if s.scenario.ReadOnly {
		writeReadOnly(w)
		return
	}
	if _, ok := s.users[username]; !ok {
		writeErr(w, http.StatusNotFound, "not_found", "no such user")
		return
	}
	q := s.quota[username]
	q.UsedBytes = 0
	q.LastResetEpochSecs = 2000
	s.quota[username] = q
	writeOK(w, http.StatusOK, struct {
		Username           string `json:"username"`
		UsedBytes          uint64 `json:"used_bytes"`
		LastResetEpochSecs int64  `json:"last_reset_epoch_secs"`
	}{username, 0, q.LastResetEpochSecs}, s.bumpRevision())
}
