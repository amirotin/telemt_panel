package httpapi

import (
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/go-webauthn/webauthn/protocol"
	wa "github.com/go-webauthn/webauthn/webauthn"
)

const (
	webAuthnChallengeTTL = 2 * time.Minute
	webAuthnBodyLimit    = 1 << 20
	webAuthnNameMaxChars = 80
	webAuthnRegisterKind = "register"
	webAuthnLoginKind    = "login"
)

type webAuthnUser struct {
	id          []byte
	username    string
	credentials []wa.Credential
}

func (u webAuthnUser) WebAuthnID() []byte                   { return u.id }
func (u webAuthnUser) WebAuthnName() string                 { return u.username }
func (u webAuthnUser) WebAuthnDisplayName() string          { return u.username }
func (u webAuthnUser) WebAuthnCredentials() []wa.Credential { return u.credentials }

type webAuthnCeremony struct {
	Session        wa.SessionData `json:"session"`
	CredentialName string         `json:"credential_name,omitempty"`
}

type webAuthnBeginResponse struct {
	FlowID    string `json:"flow_id"`
	PublicKey any    `json:"public_key"`
}

type webAuthnFinishRequest struct {
	FlowID     string          `json:"flow_id"`
	Credential json.RawMessage `json:"credential"`
}

type webAuthnRegisterBeginRequest struct {
	Name string `json:"name"`
}

func (s *Server) handleAuthMethods(w http.ResponseWriter, _ *http.Request) {
	credentials, err := s.st.ListWebAuthnCredentials()
	if err != nil {
		slog.Error("auth methods: list WebAuthn credentials", "err", err)
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not read authentication methods")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"passkey_available": len(credentials) > 0})
}

func (s *Server) webAuthnOrigin(r *http.Request) (origin, rpID string, err error) {
	host := r.Host
	if forwarded := r.Header.Get("X-Forwarded-Host"); forwarded != "" && auth.PeerTrusted(r, s.cfg.TrustedProxyPrefixes) {
		if strings.Contains(forwarded, ",") {
			return "", "", errors.New("ambiguous forwarded host")
		}
		host = strings.TrimSpace(forwarded)
	}
	if host == "" || strings.ContainsAny(host, "\r\n/@") {
		return "", "", errors.New("invalid request host")
	}
	parsed, err := url.Parse("http://" + host)
	if err != nil || parsed.Host != host || parsed.Hostname() == "" {
		return "", "", errors.New("invalid request host")
	}
	rpID = strings.TrimSuffix(strings.ToLower(parsed.Hostname()), ".")
	if rpID == "" {
		return "", "", errors.New("invalid relying party id")
	}
	scheme := "http"
	if auth.RequestIsSecure(r, s.cfg.TrustedProxyPrefixes) {
		scheme = "https"
	}
	// Browser origins canonicalize DNS names to lowercase. Keep the port and
	// IPv6 brackets exactly as parsed, but normalize host casing so a valid
	// request carrying an uppercase Host header cannot create an unusable key.
	origin = (&url.URL{Scheme: scheme, Host: strings.ToLower(host)}).String()
	return origin, rpID, nil
}

func (s *Server) webAuthnForRequest(r *http.Request) (*wa.WebAuthn, string, string, error) {
	origin, rpID, err := s.webAuthnOrigin(r)
	if err != nil {
		return nil, "", "", err
	}
	instance, err := wa.New(&wa.Config{
		RPDisplayName: "Telemt Panel",
		RPID:          rpID,
		RPOrigins:     []string{origin},
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			ResidentKey:        protocol.ResidentKeyRequirementRequired,
			RequireResidentKey: boolPointer(true),
			UserVerification:   protocol.VerificationPreferred,
		},
	})
	return instance, origin, rpID, err
}

func boolPointer(value bool) *bool { return &value }

func (s *Server) webAuthnAdminUser() (webAuthnUser, []store.WebAuthnCredential, error) {
	candidate := make([]byte, 64)
	if _, err := rand.Read(candidate); err != nil {
		return webAuthnUser{}, nil, err
	}
	handle, err := s.st.GetOrCreateWebAuthnUserHandle(candidate)
	if err != nil {
		return webAuthnUser{}, nil, err
	}
	records, err := s.st.ListWebAuthnCredentials()
	if err != nil {
		return webAuthnUser{}, nil, err
	}
	credentials := make([]wa.Credential, 0, len(records))
	for _, record := range records {
		var credential wa.Credential
		if err := json.Unmarshal(record.CredentialData, &credential); err != nil {
			return webAuthnUser{}, nil, fmt.Errorf("decode WebAuthn credential %q: %w", record.ID, err)
		}
		if base64.RawURLEncoding.EncodeToString(credential.ID) != record.ID || credential.Authenticator.SignCount != record.SignCount {
			return webAuthnUser{}, nil, fmt.Errorf("WebAuthn credential %q has inconsistent indexed fields", record.ID)
		}
		credentials = append(credentials, credential)
	}
	return webAuthnUser{id: handle, username: s.cfg.Auth.Username, credentials: credentials}, records, nil
}

func (s *Server) putWebAuthnChallenge(kind, name, origin, rpID string, session *wa.SessionData) (string, error) {
	flowID, err := auth.NewToken()
	if err != nil {
		return "", err
	}
	expires := time.Now().Add(webAuthnChallengeTTL)
	session.Expires = expires
	payload, err := json.Marshal(webAuthnCeremony{Session: *session, CredentialName: name})
	if err != nil {
		return "", err
	}
	if err := s.st.PutWebAuthnChallenge(store.WebAuthnChallenge{
		FlowHash: auth.HashToken(flowID), Kind: kind, SessionData: payload,
		Origin: origin, RPID: rpID, Expires: expires,
	}); err != nil {
		return "", err
	}
	return flowID, nil
}

func (s *Server) consumeWebAuthnChallenge(r *http.Request, flowID, kind string) (webAuthnCeremony, *wa.WebAuthn, error) {
	if flowID == "" {
		return webAuthnCeremony{}, nil, store.ErrWebAuthnChallenge
	}
	challenge, err := s.st.ConsumeWebAuthnChallenge(auth.HashToken(flowID), kind, time.Now())
	if err != nil {
		return webAuthnCeremony{}, nil, err
	}
	instance, origin, rpID, err := s.webAuthnForRequest(r)
	if err != nil || subtle.ConstantTimeCompare([]byte(challenge.Origin), []byte(origin)) != 1 || subtle.ConstantTimeCompare([]byte(challenge.RPID), []byte(rpID)) != 1 {
		return webAuthnCeremony{}, nil, store.ErrWebAuthnChallenge
	}
	var ceremony webAuthnCeremony
	if err := json.Unmarshal(challenge.SessionData, &ceremony); err != nil {
		return webAuthnCeremony{}, nil, err
	}
	return ceremony, instance, nil
}

func decodeWebAuthnFinish(w http.ResponseWriter, r *http.Request) (webAuthnFinishRequest, *http.Request, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, webAuthnBodyLimit)
	var body webAuthnFinishRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Credential) == 0 {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "invalid WebAuthn response")
		return webAuthnFinishRequest{}, nil, false
	}
	credentialRequest := r.Clone(r.Context())
	credentialRequest.Body = io.NopCloser(bytes.NewReader(body.Credential))
	credentialRequest.ContentLength = int64(len(body.Credential))
	credentialRequest.Header = r.Header.Clone()
	credentialRequest.Header.Set("Content-Type", "application/json")
	return body, credentialRequest, true
}

func (s *Server) handleWebAuthnRegisterBegin(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, webAuthnBodyLimit)
	var body webAuthnRegisterBeginRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "invalid request body")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" || utf8.RuneCountInString(body.Name) > webAuthnNameMaxChars {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "passkey name must contain 1 to 80 characters")
		return
	}
	instance, origin, rpID, err := s.webAuthnForRequest(r)
	if err != nil {
		auth.WriteError(w, http.StatusBadRequest, "invalid_webauthn_origin", "the panel host cannot be used for passkeys")
		return
	}
	user, _, err := s.webAuthnAdminUser()
	if err != nil {
		slog.Error("WebAuthn registration: load user", "err", err)
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not start passkey registration")
		return
	}
	creation, session, err := instance.BeginRegistration(user)
	if err != nil {
		slog.Error("WebAuthn registration: begin", "err", err)
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not start passkey registration")
		return
	}
	creation.Response.Timeout = int(webAuthnChallengeTTL.Milliseconds())
	flowID, err := s.putWebAuthnChallenge(webAuthnRegisterKind, body.Name, origin, rpID, session)
	if err != nil {
		if errors.Is(err, store.ErrWebAuthnChallengeLimit) {
			auth.WriteError(w, http.StatusTooManyRequests, "rate_limited", "too many active passkey requests")
			return
		}
		slog.Error("WebAuthn registration: store challenge", "err", err)
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not start passkey registration")
		return
	}
	writeJSON(w, http.StatusOK, webAuthnBeginResponse{FlowID: flowID, PublicKey: creation.Response})
}

func (s *Server) handleWebAuthnRegisterFinish(w http.ResponseWriter, r *http.Request) {
	body, credentialRequest, ok := decodeWebAuthnFinish(w, r)
	if !ok {
		return
	}
	ceremony, instance, err := s.consumeWebAuthnChallenge(r, body.FlowID, webAuthnRegisterKind)
	if err != nil {
		auth.WriteError(w, http.StatusBadRequest, "invalid_webauthn_challenge", "passkey registration expired or was already used")
		return
	}
	user, _, err := s.webAuthnAdminUser()
	if err != nil {
		slog.Error("WebAuthn registration: load user", "err", err)
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not finish passkey registration")
		return
	}
	credential, err := instance.FinishRegistration(user, ceremony.Session, credentialRequest)
	if err != nil {
		slog.Warn("WebAuthn registration: verification rejected", "err", err)
		s.appendAudit(r, "passkey.register.failed", ceremony.CredentialName, "")
		auth.WriteError(w, http.StatusBadRequest, "invalid_webauthn_response", "the authenticator response could not be verified")
		return
	}
	encoded, err := json.Marshal(credential)
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not save passkey")
		return
	}
	record := store.WebAuthnCredential{
		ID: base64.RawURLEncoding.EncodeToString(credential.ID), Name: ceremony.CredentialName,
		CredentialData: encoded, SignCount: credential.Authenticator.SignCount, Created: time.Now().UTC(),
	}
	if err := s.st.AddWebAuthnCredential(record); err != nil {
		slog.Error("WebAuthn registration: save credential", "err", err)
		if errors.Is(err, store.ErrWebAuthnCredentialExists) {
			auth.WriteError(w, http.StatusConflict, "webauthn_credential_exists", "this passkey is already registered")
		} else {
			auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not save passkey")
		}
		return
	}
	s.appendAudit(r, "passkey.register", record.ID, "")
	writeJSON(w, http.StatusCreated, passkeyInfo{ID: record.ID, Name: record.Name, Created: record.Created})
}

func (s *Server) handleWebAuthnLoginBegin(w http.ResponseWriter, r *http.Request) {
	ip := auth.ClientIP(r, s.cfg.TrustedProxyPrefixes)
	if !s.limiter.Allow(ip) {
		auth.WriteError(w, http.StatusTooManyRequests, "rate_limited", "too many failed login attempts")
		return
	}
	credentials, err := s.st.ListWebAuthnCredentials()
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not start passkey login")
		return
	}
	if len(credentials) == 0 {
		auth.WriteError(w, http.StatusNotFound, "passkey_unavailable", "no passkeys are registered")
		return
	}
	instance, origin, rpID, err := s.webAuthnForRequest(r)
	if err != nil {
		auth.WriteError(w, http.StatusBadRequest, "invalid_webauthn_origin", "the panel host cannot be used for passkeys")
		return
	}
	assertion, session, err := instance.BeginDiscoverableLogin()
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not start passkey login")
		return
	}
	assertion.Response.Timeout = int(webAuthnChallengeTTL.Milliseconds())
	flowID, err := s.putWebAuthnChallenge(webAuthnLoginKind, "", origin, rpID, session)
	if err != nil {
		if errors.Is(err, store.ErrWebAuthnChallengeLimit) {
			auth.WriteError(w, http.StatusTooManyRequests, "rate_limited", "too many active passkey requests")
			return
		}
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not start passkey login")
		return
	}
	writeJSON(w, http.StatusOK, webAuthnBeginResponse{FlowID: flowID, PublicKey: assertion.Response})
}

func (s *Server) handleWebAuthnLoginFinish(w http.ResponseWriter, r *http.Request) {
	ip := auth.ClientIP(r, s.cfg.TrustedProxyPrefixes)
	if !s.limiter.Allow(ip) {
		auth.WriteError(w, http.StatusTooManyRequests, "rate_limited", "too many failed login attempts")
		return
	}
	body, credentialRequest, ok := decodeWebAuthnFinish(w, r)
	if !ok {
		s.limiter.RecordFailure(ip)
		return
	}
	ceremony, instance, err := s.consumeWebAuthnChallenge(r, body.FlowID, webAuthnLoginKind)
	if err != nil {
		s.limiter.RecordFailure(ip)
		auth.WriteError(w, http.StatusUnauthorized, "invalid_credentials", "passkey login failed")
		return
	}
	user, records, err := s.webAuthnAdminUser()
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not verify passkey")
		return
	}
	validatedUser, credential, err := instance.FinishPasskeyLogin(func(rawID, userHandle []byte) (wa.User, error) {
		if subtle.ConstantTimeCompare(userHandle, user.id) != 1 {
			return nil, errors.New("unknown WebAuthn user")
		}
		for _, known := range user.credentials {
			if bytes.Equal(known.ID, rawID) {
				return user, nil
			}
		}
		return nil, errors.New("unknown WebAuthn credential")
	}, ceremony.Session, credentialRequest)
	if err != nil || subtle.ConstantTimeCompare(validatedUser.WebAuthnID(), user.id) != 1 {
		s.limiter.RecordFailure(ip)
		s.appendAudit(r, "login.failed", s.cfg.Auth.Username, "ip="+ip)
		auth.WriteError(w, http.StatusUnauthorized, "invalid_credentials", "passkey login failed")
		return
	}
	if credential.Authenticator.CloneWarning {
		s.limiter.RecordFailure(ip)
		s.appendAudit(r, "login.failed", s.cfg.Auth.Username, "ip="+ip)
		auth.WriteError(w, http.StatusUnauthorized, "invalid_credentials", "passkey signature counter is inconsistent")
		return
	}
	id := base64.RawURLEncoding.EncodeToString(credential.ID)
	var previous store.WebAuthnCredential
	found := false
	for _, record := range records {
		if record.ID == id {
			previous, found = record, true
			break
		}
	}
	if !found {
		auth.WriteError(w, http.StatusUnauthorized, "invalid_credentials", "passkey login failed")
		return
	}
	encoded, err := json.Marshal(credential)
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not update passkey")
		return
	}
	previous.CredentialData = encoded
	previous.SignCount = credential.Authenticator.SignCount
	previous.LastUsed = time.Now().UTC()
	if err := s.st.UpdateWebAuthnCredential(previous, recordsSignCount(records, id)); err != nil {
		if errors.Is(err, store.ErrWebAuthnCredentialChanged) || errors.Is(err, store.ErrWebAuthnCredentialNotFound) {
			slog.Warn("WebAuthn login: reject concurrent credential update", "credential", id, "err", err)
			auth.WriteError(w, http.StatusUnauthorized, "invalid_credentials", "passkey login failed")
		} else {
			slog.Error("WebAuthn login: persist credential", "credential", id, "err", err)
			auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not update passkey")
		}
		return
	}
	if err := s.createAuthenticatedSession(w, r, "passkey"); err != nil {
		slog.Error("WebAuthn login: create session", "err", err)
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not create session")
		return
	}
	s.appendAudit(r, "login", s.cfg.Auth.Username, "ip="+ip)
	w.WriteHeader(http.StatusNoContent)
}

func recordsSignCount(records []store.WebAuthnCredential, id string) uint32 {
	for _, record := range records {
		if record.ID == id {
			return record.SignCount
		}
	}
	return 0
}

func (s *Server) createAuthenticatedSession(w http.ResponseWriter, r *http.Request, method string) error {
	token, err := auth.NewToken()
	if err != nil {
		return err
	}
	now := time.Now()
	if err := s.st.PutSession(store.Session{
		IDHash: auth.HashToken(token), Created: now, LastSeen: now,
		IP: auth.ClientIP(r, s.cfg.TrustedProxyPrefixes), UserAgentLabel: userAgentLabel(r), AuthMethod: method,
	}); err != nil {
		return err
	}
	auth.SetSessionCookie(w, r, s.cfg, token)
	return nil
}

func (s *Server) handleWebAuthnCredentialDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("credentialId")
	if err := s.st.DeleteWebAuthnCredential(id); err != nil {
		if errors.Is(err, store.ErrWebAuthnCredentialNotFound) {
			auth.WriteError(w, http.StatusNotFound, "not_found", "passkey not found")
			return
		}
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not delete passkey")
		return
	}
	s.appendAudit(r, "passkey.delete", id, "")
	w.WriteHeader(http.StatusNoContent)
}
