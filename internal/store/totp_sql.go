//go:build !lite

package store

import (
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

func (s *SQLite) GetTOTPState() (TOTPState, error) {
	var state TOTPState
	var pendingExpires int64
	err := s.queryRow(`SELECT enabled, secret, pending_secret, pending_expires, last_timestep,
        (SELECT COUNT(*) FROM auth_recovery_codes) FROM auth_totp WHERE singleton = 1`).Scan(
		&state.Enabled, &state.Secret, &state.PendingSecret, &pendingExpires, &state.LastTimestep, &state.RecoveryCodes,
	)
	if err != nil {
		return TOTPState{}, fmt.Errorf("read TOTP state: %w", err)
	}
	if pendingExpires > 0 {
		state.PendingExpires = time.Unix(pendingExpires, 0)
	}
	return state, nil
}

func (s *SQLite) BeginTOTPSetup(secret string, expires time.Time) error {
	if secret == "" || expires.IsZero() {
		return ErrTOTPSetupInvalid
	}
	result, err := s.exec(`UPDATE auth_totp SET pending_secret = ?, pending_expires = ? WHERE singleton = 1 AND enabled = ?`, secret, expires.Unix(), false)
	if err != nil {
		return wrapSQLError("begin TOTP setup", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("begin TOTP setup rows affected: %w", err)
	}
	if affected != 1 {
		return ErrTOTPAlreadyEnabled
	}
	return nil
}

func (s *SQLite) EnableTOTP(expectedSecret string, now time.Time, recoveryHashes [][]byte) error {
	if len(recoveryHashes) != 10 {
		return fmt.Errorf("enable TOTP: expected 10 recovery hashes, got %d", len(recoveryHashes))
	}
	seen := make(map[string]struct{}, len(recoveryHashes))
	for _, hash := range recoveryHashes {
		if len(hash) != sha256.Size {
			return fmt.Errorf("enable TOTP: recovery hash must be %d bytes", sha256.Size)
		}
		key := string(hash)
		if _, duplicate := seen[key]; duplicate {
			return errors.New("enable TOTP: duplicate recovery hash")
		}
		seen[key] = struct{}{}
	}

	err := s.withOperationTx(func(tx *sql.Tx) error {
		result, err := tx.Exec(s.bind(`UPDATE auth_totp SET enabled = ?, secret = pending_secret, pending_secret = '', pending_expires = 0, last_timestep = -1
            WHERE singleton = 1 AND enabled = ? AND pending_secret = ? AND pending_expires > ?`), true, false, expectedSecret, now.Unix())
		if err != nil {
			return err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if affected != 1 {
			return ErrTOTPSetupInvalid
		}
		if _, err := tx.Exec(`DELETE FROM auth_recovery_codes`); err != nil {
			return err
		}
		for _, hash := range recoveryHashes {
			if _, err := tx.Exec(s.bind(`INSERT INTO auth_recovery_codes(code_hash) VALUES(?)`), hash); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		if errors.Is(err, ErrTOTPSetupInvalid) {
			return err
		}
		return fmt.Errorf("enable TOTP: %w", err)
	}
	return nil
}

func (s *SQLite) DisableTOTP() error {
	err := s.withOperationTx(func(tx *sql.Tx) error {
		if _, err := tx.Exec(s.bind(`UPDATE auth_totp SET enabled = ?, secret = '', pending_secret = '', pending_expires = 0, last_timestep = -1 WHERE singleton = 1`), false); err != nil {
			return err
		}
		_, err := tx.Exec(`DELETE FROM auth_recovery_codes`)
		return err
	})
	return wrapSQLError("disable TOTP", err)
}

func (s *SQLite) AcceptTOTPTimestep(timestep int64) error {
	result, err := s.exec(`UPDATE auth_totp SET last_timestep = ? WHERE singleton = 1 AND enabled = ? AND last_timestep < ?`, timestep, true, timestep)
	if err != nil {
		return wrapSQLError("accept TOTP timestep", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("accept TOTP timestep rows affected: %w", err)
	}
	if affected != 1 {
		return ErrTOTPReplay
	}
	return nil
}

func (s *SQLite) ConsumeRecoveryCode(hash []byte) error {
	if len(hash) != sha256.Size {
		return ErrRecoveryCode
	}
	result, err := s.exec(`DELETE FROM auth_recovery_codes WHERE code_hash = ? AND EXISTS (SELECT 1 FROM auth_totp WHERE singleton = 1 AND enabled = ?)`, hash, true)
	if err != nil {
		return wrapSQLError("consume recovery code", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("consume recovery code rows affected: %w", err)
	}
	if affected != 1 {
		return ErrRecoveryCode
	}
	return nil
}
