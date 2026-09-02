package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

const maxWebAccessBody = 64 << 10

type webAccessView struct {
	Revision string               `json:"revision"`
	Enabled  bool                 `json:"enabled"`
	Vhosts   []webAccessVhostView `json:"vhosts"`
}

type webAccessVhostView struct {
	Host       string                 `json:"host"`
	PublicAddr string                 `json:"public_addr"`
	Profiles   []webAccessProfileView `json:"profiles"`
}

type webAccessProfileView struct {
	User                 string  `json:"user"`
	SecretMode           string  `json:"secret_mode"`
	MaxSessions          *uint64 `json:"max_sessions,omitempty"`
	MaxStreams           *uint64 `json:"max_streams,omitempty"`
	MaxStreamsPerSession *uint64 `json:"max_streams_per_session,omitempty"`
}

type webUserAccessUpdate struct {
	Profiles []webUserAccessProfile `json:"profiles"`
}

type webUserAccessProfile struct {
	Vhost                string  `json:"vhost"`
	SecretMode           string  `json:"secret_mode"`
	MaxSessions          *uint64 `json:"max_sessions,omitempty"`
	MaxStreams           *uint64 `json:"max_streams,omitempty"`
	MaxStreamsPerSession *uint64 `json:"max_streams_per_session,omitempty"`
}

// handleGetTelemtWebAccess projects WEB vhosts and their user relationships
// without exposing the rest of the configuration document to the People UI.
func (s *Server) handleGetTelemtWebAccess(w http.ResponseWriter, r *http.Request) {
	if !s.requireConfigAPI(w, r) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), telemtConfigRequestTimeout)
	defer cancel()
	sections, revision, err := s.tc.GetConfig(ctx)
	if err != nil {
		writeTelemtConfigError(w, err)
		return
	}
	view, err := projectWebAccess(sections["web"], revision)
	if err != nil {
		auth.WriteError(w, http.StatusBadGateway, "internal_error", "invalid WEB config returned by Telemt")
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// handlePutTelemtUserWebAccess replaces only one user's WEB profile
// relationships. The whole vhost array is sent because Telemt's Config API
// replaces arrays atomically; If-Match prevents overwriting concurrent edits.
func (s *Server) handlePutTelemtUserWebAccess(w http.ResponseWriter, r *http.Request) {
	if !s.requireConfigAPI(w, r) {
		return
	}
	revision := strings.TrimSpace(r.Header.Get("If-Match"))
	if revision == "" {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "If-Match header is required")
		return
	}
	var req webUserAccessUpdate
	decoder := json.NewDecoder(io.LimitReader(r.Body, maxWebAccessBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "invalid WEB access request")
		return
	}
	username := strings.TrimSpace(r.PathValue("username"))
	if username == "" {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "username is required")
		return
	}
	if err := validateWebUserProfiles(req.Profiles); err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), telemtConfigRequestTimeout)
	defer cancel()
	sections, currentRevision, err := s.tc.GetConfig(ctx)
	if err != nil {
		writeTelemtConfigError(w, err)
		return
	}
	if currentRevision != revision {
		auth.WriteError(w, http.StatusConflict, "revision_conflict", "config revision mismatch")
		return
	}
	webPatch, err := replaceWebUserProfiles(sections["web"], username, req.Profiles)
	if err != nil {
		var profileErr *webProfileConstraintError
		if ok := asWebProfileConstraint(err, &profileErr); ok {
			auth.WriteError(w, profileErr.status, profileErr.code, profileErr.Error())
			return
		}
		auth.WriteError(w, http.StatusBadGateway, "internal_error", "could not prepare WEB profile update")
		return
	}
	result, status, _, err := s.tc.PatchConfig(ctx, map[string]any{"web": webPatch}, revision, telemt.ReloadQuery{Mode: "instant"})
	if err != nil {
		writeTelemtConfigError(w, err)
		return
	}
	s.appendAudit(r, "config.web_access", username, fmt.Sprintf("profiles=%d", len(req.Profiles)))
	writeJSON(w, status, result)
}

// detachWebAccessForUser removes WEB relationships before the access user is
// deleted. Telemt stores the two entities in different config areas and does
// not cascade between them, so leaving profiles behind would create dangling
// usernames. The returned rollback restores the original WEB section if the
// subsequent user deletion is rejected.
func (s *Server) detachWebAccessForUser(ctx context.Context, username string) (func(context.Context) error, bool, error) {
	caps, err := s.tc.Capabilities(ctx)
	if err != nil || !caps.ConfigAPI {
		return func(context.Context) error { return nil }, false, nil
	}
	sections, revision, err := s.tc.GetConfig(ctx)
	if err != nil {
		return nil, false, err
	}
	raw := sections["web"]
	if !rawWebHasUser(raw, username) {
		return func(context.Context) error { return nil }, false, nil
	}
	patch, err := replaceWebUserProfiles(raw, username, nil)
	if err != nil {
		return nil, false, err
	}
	result, _, responseRevision, err := s.tc.PatchConfig(ctx, map[string]any{"web": patch}, revision, telemt.ReloadQuery{Mode: "instant"})
	if err != nil {
		return nil, false, err
	}
	updatedRevision := result.Revision
	if updatedRevision == "" {
		updatedRevision = responseRevision
	}
	rollback := func(rollbackCtx context.Context) error {
		var original any
		if err := json.Unmarshal(raw, &original); err != nil {
			return err
		}
		_, _, _, err := s.tc.PatchConfig(rollbackCtx, map[string]any{"web": original}, updatedRevision, telemt.ReloadQuery{Mode: "instant"})
		return err
	}
	return rollback, true, nil
}

type webProfileConstraintError struct {
	status int
	code   string
	msg    string
}

func (e *webProfileConstraintError) Error() string { return e.msg }

func asWebProfileConstraint(err error, target **webProfileConstraintError) bool {
	value, ok := err.(*webProfileConstraintError)
	if ok {
		*target = value
	}
	return ok
}

func projectWebAccess(raw json.RawMessage, revision string) (webAccessView, error) {
	view := webAccessView{Revision: revision, Vhosts: []webAccessVhostView{}}
	if len(bytes.TrimSpace(raw)) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return view, nil
	}
	var doc struct {
		Enabled bool `json:"enabled"`
		Vhosts  []struct {
			Host       string                 `json:"host"`
			PublicAddr string                 `json:"public_addr"`
			Profiles   []webAccessProfileView `json:"profiles"`
		} `json:"vhosts"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return view, err
	}
	view.Enabled = doc.Enabled
	for _, vhost := range doc.Vhosts {
		profiles := vhost.Profiles
		if profiles == nil {
			profiles = []webAccessProfileView{}
		}
		view.Vhosts = append(view.Vhosts, webAccessVhostView{Host: vhost.Host, PublicAddr: vhost.PublicAddr, Profiles: profiles})
	}
	return view, nil
}

func rawWebHasUser(raw json.RawMessage, username string) bool {
	var doc struct {
		Vhosts []struct {
			Profiles []struct {
				User string `json:"user"`
			} `json:"profiles"`
		} `json:"vhosts"`
	}
	if json.Unmarshal(raw, &doc) != nil {
		return false
	}
	for _, vhost := range doc.Vhosts {
		for _, profile := range vhost.Profiles {
			if profile.User == username {
				return true
			}
		}
	}
	return false
}

func validateWebUserProfiles(profiles []webUserAccessProfile) error {
	seen := make(map[string]struct{}, len(profiles))
	for _, profile := range profiles {
		vhost := strings.TrimSpace(profile.Vhost)
		if vhost == "" {
			return fmt.Errorf("vhost is required")
		}
		if profile.SecretMode != "plain" && profile.SecretMode != "dd" {
			return fmt.Errorf("secret_mode must be plain or dd")
		}
		key := vhost + "\x00" + profile.SecretMode
		if _, exists := seen[key]; exists {
			return fmt.Errorf("duplicate WEB profile for vhost and secret mode")
		}
		seen[key] = struct{}{}
		for _, limit := range []*uint64{profile.MaxSessions, profile.MaxStreams, profile.MaxStreamsPerSession} {
			if limit != nil && *limit == 0 {
				return fmt.Errorf("WEB profile limits must be greater than zero")
			}
		}
	}
	return nil
}

func replaceWebUserProfiles(raw json.RawMessage, username string, requested []webUserAccessProfile) (map[string]any, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, &webProfileConstraintError{status: http.StatusConflict, code: "web_vhost_not_found", msg: "WEB is not configured"}
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	var vhosts []map[string]json.RawMessage
	if rawVhosts := doc["vhosts"]; len(rawVhosts) > 0 {
		if err := json.Unmarshal(rawVhosts, &vhosts); err != nil {
			return nil, err
		}
	}
	requestedByVhost := make(map[string][]webUserAccessProfile)
	for _, profile := range requested {
		profile.Vhost = strings.TrimSpace(profile.Vhost)
		requestedByVhost[profile.Vhost] = append(requestedByVhost[profile.Vhost], profile)
	}
	existingByKey := make(map[string]map[string]json.RawMessage)
	seenVhosts := make(map[string]bool, len(vhosts))
	webEnabled := rawJSONBool(doc["enabled"])
	for _, vhost := range vhosts {
		host := rawJSONString(vhost["host"])
		seenVhosts[host] = true
		var profiles []map[string]json.RawMessage
		if rawProfiles := vhost["profiles"]; len(rawProfiles) > 0 {
			if err := json.Unmarshal(rawProfiles, &profiles); err != nil {
				return nil, err
			}
		}
		kept := make([]map[string]json.RawMessage, 0, len(profiles)+len(requestedByVhost[host]))
		for _, profile := range profiles {
			if rawJSONString(profile["user"]) == username {
				key := host + "\x00" + rawJSONString(profile["secret_mode"])
				existingByKey[key] = profile
				continue
			}
			kept = append(kept, profile)
		}
		for _, desired := range requestedByVhost[host] {
			key := host + "\x00" + desired.SecretMode
			profile := cloneRawMap(existingByKey[key])
			setRawJSON(profile, "user", username)
			setRawJSON(profile, "secret_mode", desired.SecretMode)
			setOptionalRawUint(profile, "max_sessions", desired.MaxSessions)
			setOptionalRawUint(profile, "max_streams", desired.MaxStreams)
			setOptionalRawUint(profile, "max_streams_per_session", desired.MaxStreamsPerSession)
			kept = append(kept, profile)
		}
		if webEnabled && len(kept) == 0 {
			return nil, &webProfileConstraintError{status: http.StatusConflict, code: "web_profile_required", msg: "an enabled WEB vhost must keep at least one profile"}
		}
		encoded, err := json.Marshal(kept)
		if err != nil {
			return nil, err
		}
		vhost["profiles"] = encoded
	}
	for host := range requestedByVhost {
		if !seenVhosts[host] {
			return nil, &webProfileConstraintError{status: http.StatusNotFound, code: "web_vhost_not_found", msg: "WEB vhost not found"}
		}
	}
	return map[string]any{"vhosts": vhosts}, nil
}

func rawJSONString(raw json.RawMessage) string {
	var value string
	_ = json.Unmarshal(raw, &value)
	return value
}

func rawJSONBool(raw json.RawMessage) bool {
	var value bool
	_ = json.Unmarshal(raw, &value)
	return value
}

func cloneRawMap(value map[string]json.RawMessage) map[string]json.RawMessage {
	clone := make(map[string]json.RawMessage, len(value)+5)
	for key, raw := range value {
		clone[key] = append(json.RawMessage(nil), raw...)
	}
	return clone
}

func setRawJSON(target map[string]json.RawMessage, key string, value any) {
	raw, _ := json.Marshal(value)
	target[key] = raw
}

func setOptionalRawUint(target map[string]json.RawMessage, key string, value *uint64) {
	if value == nil {
		delete(target, key)
		return
	}
	setRawJSON(target, key, *value)
}
