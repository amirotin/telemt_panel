package store

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

const passwordIdentityKey = "auth.password_identity.v1"

// BindPasswordAuth binds persisted sessions to the configured admin credentials.
// It runs before serving requests. Legacy sessions have no binding and are
// revoked once. The config remains the only password source; this fingerprint
// cannot authenticate a user. Settings export/import carries the binding along
// with sessions so a different destination account cannot inherit them.
func (m *Memory) BindPasswordAuth(username, passwordHash string) error {
	raw, _ := json.Marshal([2]string{username, passwordHash})
	digest := sha256.Sum256(raw)
	identity := hex.EncodeToString(digest[:])
	m.mu.Lock()
	defer m.mu.Unlock()
	previous, existed := m.settings[passwordIdentityKey]
	if previous == identity {
		return nil
	}
	sessions, challenges := m.sessions, m.webauthnChallenges
	m.sessions = make(map[string]Session)
	m.webauthnChallenges = make(map[string]WebAuthnChallenge)
	m.settings[passwordIdentityKey] = identity
	if err := m.writeStateLocked(); err != nil {
		m.sessions, m.webauthnChallenges = sessions, challenges
		if existed {
			m.settings[passwordIdentityKey] = previous
		} else {
			delete(m.settings, passwordIdentityKey)
		}
		return err
	}
	return nil
}
