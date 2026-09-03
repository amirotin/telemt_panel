package store

import (
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"slices"
	"time"
	"unicode/utf8"
)

const (
	webAuthnUserHandleBytes      = 64
	webAuthnCredentialIDMaxBytes = 2048
	webAuthnChallengeLimit       = 64
)

func cloneWebAuthnCredential(value WebAuthnCredential) WebAuthnCredential {
	value.CredentialData = append([]byte(nil), value.CredentialData...)
	return value
}

func cloneWebAuthnCredentials(values map[string]WebAuthnCredential) map[string]WebAuthnCredential {
	out := make(map[string]WebAuthnCredential, len(values))
	for id, value := range values {
		out[id] = cloneWebAuthnCredential(value)
	}
	return out
}

func cloneWebAuthnChallenges(values map[string]WebAuthnChallenge) map[string]WebAuthnChallenge {
	out := make(map[string]WebAuthnChallenge, len(values))
	for hash, value := range values {
		value.SessionData = append([]byte(nil), value.SessionData...)
		out[hash] = value
	}
	return out
}

func validateWebAuthnCredential(value WebAuthnCredential) error {
	if value.ID == "" || value.Name == "" || len(value.CredentialData) == 0 || value.Created.IsZero() {
		return fmt.Errorf("incomplete WebAuthn credential")
	}
	if _, err := base64.RawURLEncoding.DecodeString(value.ID); err != nil {
		return fmt.Errorf("invalid WebAuthn credential id")
	}
	if len(value.ID) > webAuthnCredentialIDMaxBytes || utf8.RuneCountInString(value.Name) > 200 || len(value.CredentialData) > 1<<20 {
		return fmt.Errorf("WebAuthn credential exceeds storage limits")
	}
	return nil
}

func validateWebAuthnChallenge(value WebAuthnChallenge) error {
	if value.FlowHash == "" || value.Kind == "" || len(value.SessionData) == 0 || value.Origin == "" || value.RPID == "" || value.Expires.IsZero() {
		return fmt.Errorf("incomplete WebAuthn challenge")
	}
	if decoded, err := hex.DecodeString(value.FlowHash); err != nil || len(decoded) != 32 {
		return fmt.Errorf("invalid WebAuthn flow hash")
	}
	if len(value.Kind) > 32 || len(value.SessionData) > 1<<20 || len(value.Origin) > 2048 || len(value.RPID) > 255 {
		return fmt.Errorf("WebAuthn challenge exceeds storage limits")
	}
	return nil
}

func validatePortableWebAuthn(handle []byte, credentials map[string]WebAuthnCredential, challenges map[string]WebAuthnChallenge) error {
	if len(handle) != 0 && len(handle) != webAuthnUserHandleBytes {
		return fmt.Errorf("WebAuthn user handle must be %d bytes", webAuthnUserHandleBytes)
	}
	if len(credentials) > 0 && len(handle) == 0 {
		return fmt.Errorf("WebAuthn credentials require a user handle")
	}
	if len(challenges) > webAuthnChallengeLimit {
		return fmt.Errorf("WebAuthn challenge count exceeds %d", webAuthnChallengeLimit)
	}
	for id, credential := range credentials {
		if id != credential.ID {
			return fmt.Errorf("WebAuthn credential map key %q does not match id %q", id, credential.ID)
		}
		if err := validateWebAuthnCredential(credential); err != nil {
			return fmt.Errorf("credential %q: %w", id, err)
		}
	}
	for hash, challenge := range challenges {
		if hash != challenge.FlowHash {
			return fmt.Errorf("WebAuthn challenge map key %q does not match flow hash %q", hash, challenge.FlowHash)
		}
		if err := validateWebAuthnChallenge(challenge); err != nil {
			return fmt.Errorf("challenge %q: %w", hash, err)
		}
	}
	return nil
}

func (m *Memory) GetOrCreateWebAuthnUserHandle(candidate []byte) ([]byte, error) {
	if len(candidate) != webAuthnUserHandleBytes {
		return nil, fmt.Errorf("WebAuthn user handle must be %d bytes", webAuthnUserHandleBytes)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.webauthnUserHandle) != 0 {
		return append([]byte(nil), m.webauthnUserHandle...), nil
	}
	m.webauthnUserHandle = append([]byte(nil), candidate...)
	if err := m.writeStateLocked(); err != nil {
		m.webauthnUserHandle = nil
		return nil, err
	}
	return append([]byte(nil), candidate...), nil
}

func (m *Memory) ListWebAuthnCredentials() ([]WebAuthnCredential, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]WebAuthnCredential, 0, len(m.webauthnCredentials))
	for _, credential := range m.webauthnCredentials {
		out = append(out, cloneWebAuthnCredential(credential))
	}
	slices.SortFunc(out, func(a, b WebAuthnCredential) int { return b.Created.Compare(a.Created) })
	return out, nil
}

func (m *Memory) GetWebAuthnCredential(id string) (WebAuthnCredential, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	credential, ok := m.webauthnCredentials[id]
	return cloneWebAuthnCredential(credential), ok, nil
}

func (m *Memory) AddWebAuthnCredential(credential WebAuthnCredential) error {
	if err := validateWebAuthnCredential(credential); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.webauthnUserHandle) == 0 {
		return fmt.Errorf("WebAuthn user handle is not initialized")
	}
	if _, exists := m.webauthnCredentials[credential.ID]; exists {
		return ErrWebAuthnCredentialExists
	}
	m.webauthnCredentials[credential.ID] = cloneWebAuthnCredential(credential)
	if err := m.writeStateLocked(); err != nil {
		delete(m.webauthnCredentials, credential.ID)
		return err
	}
	return nil
}

func (m *Memory) DeleteWebAuthnCredential(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	credential, exists := m.webauthnCredentials[id]
	if !exists {
		return ErrWebAuthnCredentialNotFound
	}
	delete(m.webauthnCredentials, id)
	if err := m.writeStateLocked(); err != nil {
		m.webauthnCredentials[id] = credential
		return err
	}
	return nil
}

func (m *Memory) UpdateWebAuthnCredential(credential WebAuthnCredential, oldSignCount uint32) error {
	if err := validateWebAuthnCredential(credential); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	previous, exists := m.webauthnCredentials[credential.ID]
	if !exists {
		return ErrWebAuthnCredentialNotFound
	}
	if previous.SignCount != oldSignCount {
		return ErrWebAuthnCredentialChanged
	}
	m.webauthnCredentials[credential.ID] = cloneWebAuthnCredential(credential)
	if err := m.writeStateLocked(); err != nil {
		m.webauthnCredentials[credential.ID] = previous
		return err
	}
	return nil
}

func (m *Memory) PutWebAuthnChallenge(challenge WebAuthnChallenge) error {
	if err := validateWebAuthnChallenge(challenge); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for hash, existing := range m.webauthnChallenges {
		if !existing.Expires.After(time.Now()) {
			delete(m.webauthnChallenges, hash)
		}
	}
	if _, replacing := m.webauthnChallenges[challenge.FlowHash]; !replacing && len(m.webauthnChallenges) >= webAuthnChallengeLimit {
		return ErrWebAuthnChallengeLimit
	}
	challenge.SessionData = append([]byte(nil), challenge.SessionData...)
	m.webauthnChallenges[challenge.FlowHash] = challenge
	return nil
}

func (m *Memory) ConsumeWebAuthnChallenge(flowHash, kind string, now time.Time) (WebAuthnChallenge, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	challenge, exists := m.webauthnChallenges[flowHash]
	if !exists {
		return WebAuthnChallenge{}, ErrWebAuthnChallenge
	}
	delete(m.webauthnChallenges, flowHash)
	if challenge.Kind != kind || !challenge.Expires.After(now) {
		return WebAuthnChallenge{}, ErrWebAuthnChallenge
	}
	challenge.SessionData = append([]byte(nil), challenge.SessionData...)
	return challenge, nil
}
