package store

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"time"
)

func recoveryCodeKeys(codes map[string]struct{}) []string {
	out := make([]string, 0, len(codes))
	for hash := range codes {
		out = append(out, hash)
	}
	sort.Strings(out)
	return out
}

func cloneRecoveryCodes(codes map[string]struct{}) map[string]struct{} {
	out := make(map[string]struct{}, len(codes))
	for hash := range codes {
		out[hash] = struct{}{}
	}
	return out
}

func recoveryCodeHashes(codes map[string]struct{}) [][]byte {
	out := make([][]byte, 0, len(codes))
	for _, key := range recoveryCodeKeys(codes) {
		decoded, _ := hex.DecodeString(key)
		out = append(out, decoded)
	}
	return out
}

func recoveryCodeMap(hashes [][]byte) map[string]struct{} {
	out := make(map[string]struct{}, len(hashes))
	for _, hash := range hashes {
		out[hex.EncodeToString(hash)] = struct{}{}
	}
	return out
}

func validatePortableTOTP(state TOTPState, hashes [][]byte) error {
	seen := make(map[string]struct{}, len(hashes))
	for _, hash := range hashes {
		key, err := recoveryHashKey(hash)
		if err != nil {
			return fmt.Errorf("invalid TOTP recovery hash: %w", err)
		}
		if _, duplicate := seen[key]; duplicate {
			return fmt.Errorf("duplicate TOTP recovery hash")
		}
		seen[key] = struct{}{}
	}
	if state.Enabled {
		if state.Secret == "" || state.PendingSecret != "" {
			return fmt.Errorf("invalid enabled TOTP state")
		}
		return nil
	}
	if state.Secret != "" || len(hashes) != 0 {
		return fmt.Errorf("disabled TOTP state contains enabled credentials")
	}
	if (state.PendingSecret == "") != state.PendingExpires.IsZero() {
		return fmt.Errorf("incomplete pending TOTP state")
	}
	return nil
}

func recoveryHashKey(hash []byte) (string, error) {
	if len(hash) != sha256.Size {
		return "", fmt.Errorf("recovery hash must be %d bytes", sha256.Size)
	}
	return hex.EncodeToString(hash), nil
}

func validRecoveryCodeKey(key string) bool {
	decoded, err := hex.DecodeString(key)
	return err == nil && len(decoded) == sha256.Size
}

func (m *Memory) GetTOTPState() (TOTPState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	state := m.totp
	state.RecoveryCodes = len(m.recoveryCodes)
	return state, nil
}

func (m *Memory) BeginTOTPSetup(secret string, expires time.Time) error {
	if secret == "" || expires.IsZero() {
		return ErrTOTPSetupInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.totp.Enabled {
		return ErrTOTPAlreadyEnabled
	}
	previous := m.totp
	m.totp.PendingSecret = secret
	m.totp.PendingExpires = expires
	if err := m.writeStateLocked(); err != nil {
		m.totp = previous
		return err
	}
	return nil
}

func (m *Memory) EnableTOTP(expectedSecret string, now time.Time, recoveryHashes [][]byte) error {
	if len(recoveryHashes) != 10 {
		return fmt.Errorf("enable TOTP: expected 10 recovery hashes, got %d", len(recoveryHashes))
	}
	codes := make(map[string]struct{}, len(recoveryHashes))
	for _, hash := range recoveryHashes {
		key, err := recoveryHashKey(hash)
		if err != nil {
			return err
		}
		if _, duplicate := codes[key]; duplicate {
			return fmt.Errorf("enable TOTP: duplicate recovery hash")
		}
		codes[key] = struct{}{}
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.totp.Enabled || expectedSecret == "" || m.totp.PendingSecret != expectedSecret || !m.totp.PendingExpires.After(now) {
		return ErrTOTPSetupInvalid
	}
	previousState := m.totp
	previousCodes := m.recoveryCodes
	m.totp = TOTPState{Enabled: true, Secret: expectedSecret, LastTimestep: -1, RecoveryCodes: len(codes)}
	m.recoveryCodes = codes
	if err := m.writeStateLocked(); err != nil {
		m.totp = previousState
		m.recoveryCodes = previousCodes
		return err
	}
	return nil
}

func (m *Memory) DisableTOTP() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	previousState := m.totp
	previousCodes := cloneRecoveryCodes(m.recoveryCodes)
	m.totp = TOTPState{LastTimestep: -1}
	m.recoveryCodes = make(map[string]struct{})
	if err := m.writeStateLocked(); err != nil {
		m.totp = previousState
		m.recoveryCodes = previousCodes
		return err
	}
	return nil
}

func (m *Memory) AcceptTOTPTimestep(timestep int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.totp.Enabled || timestep <= m.totp.LastTimestep {
		return ErrTOTPReplay
	}
	previous := m.totp.LastTimestep
	m.totp.LastTimestep = timestep
	if err := m.writeStateLocked(); err != nil {
		m.totp.LastTimestep = previous
		return err
	}
	return nil
}

func (m *Memory) ConsumeRecoveryCode(hash []byte) error {
	key, err := recoveryHashKey(hash)
	if err != nil {
		return ErrRecoveryCode
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.totp.Enabled {
		return ErrRecoveryCode
	}
	if _, ok := m.recoveryCodes[key]; !ok {
		return ErrRecoveryCode
	}
	delete(m.recoveryCodes, key)
	m.totp.RecoveryCodes = len(m.recoveryCodes)
	if err := m.writeStateLocked(); err != nil {
		m.recoveryCodes[key] = struct{}{}
		m.totp.RecoveryCodes = len(m.recoveryCodes)
		return err
	}
	return nil
}
