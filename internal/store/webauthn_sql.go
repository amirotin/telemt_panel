//go:build !lite

package store

import (
	"bytes"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

func (s *SQLite) GetOrCreateWebAuthnUserHandle(candidate []byte) ([]byte, error) {
	if len(candidate) != webAuthnUserHandleBytes {
		return nil, fmt.Errorf("WebAuthn user handle must be %d bytes", webAuthnUserHandleBytes)
	}
	var handle []byte
	err := s.withOperationTx(func(tx *sql.Tx) error {
		var insert string
		switch s.driver {
		case "sqlite":
			insert = `INSERT OR IGNORE INTO auth_webauthn_user(singleton, user_handle) VALUES(1, ?)`
		case "postgres":
			insert = `INSERT INTO auth_webauthn_user(singleton, user_handle) VALUES(1, ?) ON CONFLICT (singleton) DO NOTHING`
		case "mysql":
			insert = `INSERT IGNORE INTO auth_webauthn_user(singleton, user_handle) VALUES(1, ?)`
		default:
			return fmt.Errorf("unsupported SQL driver %q", s.driver)
		}
		if _, err := tx.Exec(s.bind(insert), candidate); err != nil {
			return err
		}
		return tx.QueryRow(s.bind(`SELECT user_handle FROM auth_webauthn_user WHERE singleton = 1`)).Scan(&handle)
	})
	if err != nil {
		return nil, wrapSQLError("get or create WebAuthn user handle", err)
	}
	return append([]byte(nil), handle...), nil
}

func scanWebAuthnCredential(scanner interface{ Scan(...any) error }) (WebAuthnCredential, error) {
	var credential WebAuthnCredential
	var signCount int64
	var created, lastUsed int64
	if err := scanner.Scan(&credential.ID, &credential.Name, &credential.CredentialData, &signCount, &created, &lastUsed); err != nil {
		return WebAuthnCredential{}, err
	}
	if signCount < 0 || uint64(signCount) > uint64(^uint32(0)) {
		return WebAuthnCredential{}, fmt.Errorf("invalid WebAuthn sign count %d", signCount)
	}
	credential.SignCount = uint32(signCount)
	credential.Created = time.Unix(created, 0).UTC()
	if lastUsed > 0 {
		credential.LastUsed = time.Unix(lastUsed, 0).UTC()
	}
	return credential, nil
}

func (s *SQLite) ListWebAuthnCredentials() ([]WebAuthnCredential, error) {
	rows, err := s.query(`SELECT credential_id, name, credential_data, sign_count, created, last_used FROM auth_webauthn_credentials ORDER BY created DESC`)
	if err != nil {
		return nil, wrapSQLError("list WebAuthn credentials", err)
	}
	defer rows.Close()
	var out []WebAuthnCredential
	for rows.Next() {
		credential, err := scanWebAuthnCredential(rows)
		if err != nil {
			return nil, wrapSQLError("scan WebAuthn credential", err)
		}
		out = append(out, credential)
	}
	return out, wrapSQLError("list WebAuthn credentials", rows.Err())
}

func (s *SQLite) GetWebAuthnCredential(id string) (WebAuthnCredential, bool, error) {
	credential, err := scanWebAuthnCredential(s.queryRow(`SELECT credential_id, name, credential_data, sign_count, created, last_used FROM auth_webauthn_credentials WHERE credential_id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return WebAuthnCredential{}, false, nil
	}
	if err != nil {
		return WebAuthnCredential{}, false, wrapSQLError("get WebAuthn credential", err)
	}
	return credential, true, nil
}

func (s *SQLite) AddWebAuthnCredential(credential WebAuthnCredential) error {
	if err := validateWebAuthnCredential(credential); err != nil {
		return err
	}
	var userCount int
	if err := s.queryRow(`SELECT count(*) FROM auth_webauthn_user`).Scan(&userCount); err != nil {
		return wrapSQLError("inspect WebAuthn user handle", err)
	}
	if userCount != 1 {
		return fmt.Errorf("WebAuthn user handle is not initialized")
	}
	insert := `INSERT INTO auth_webauthn_credentials(credential_id, name, credential_data, sign_count, created, last_used) VALUES(?, ?, ?, ?, ?, ?)`
	switch s.driver {
	case "sqlite":
		insert = `INSERT OR IGNORE INTO auth_webauthn_credentials(credential_id, name, credential_data, sign_count, created, last_used) VALUES(?, ?, ?, ?, ?, ?)`
	case "postgres":
		insert += ` ON CONFLICT (credential_id) DO NOTHING`
	case "mysql":
		insert = `INSERT IGNORE INTO auth_webauthn_credentials(credential_id, name, credential_data, sign_count, created, last_used) VALUES(?, ?, ?, ?, ?, ?)`
	default:
		return fmt.Errorf("unsupported SQL driver %q", s.driver)
	}
	result, err := s.exec(insert, credential.ID, credential.Name, credential.CredentialData, int64(credential.SignCount), credential.Created.Unix(), unixOrZero(credential.LastUsed))
	if err != nil {
		return wrapSQLError("add WebAuthn credential", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("add WebAuthn credential rows affected: %w", err)
	}
	if affected != 1 {
		return ErrWebAuthnCredentialExists
	}
	return nil
}

func (s *SQLite) DeleteWebAuthnCredential(id string) error {
	result, err := s.exec(`DELETE FROM auth_webauthn_credentials WHERE credential_id = ?`, id)
	if err != nil {
		return wrapSQLError("delete WebAuthn credential", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("delete WebAuthn credential rows affected: %w", err)
	}
	if affected != 1 {
		return ErrWebAuthnCredentialNotFound
	}
	return nil
}

func (s *SQLite) UpdateWebAuthnCredential(credential WebAuthnCredential, oldSignCount uint32) error {
	if err := validateWebAuthnCredential(credential); err != nil {
		return err
	}
	result, err := s.exec(`UPDATE auth_webauthn_credentials SET name = ?, credential_data = ?, sign_count = ?, last_used = ? WHERE credential_id = ? AND sign_count = ?`, credential.Name, credential.CredentialData, int64(credential.SignCount), unixOrZero(credential.LastUsed), credential.ID, int64(oldSignCount))
	if err != nil {
		return wrapSQLError("update WebAuthn credential", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("update WebAuthn credential rows affected: %w", err)
	}
	if affected != 1 {
		current, exists, lookupErr := s.GetWebAuthnCredential(credential.ID)
		if lookupErr != nil {
			return lookupErr
		}
		if !exists {
			return ErrWebAuthnCredentialNotFound
		}
		// MySQL reports changed rows rather than matched rows by default. A
		// counter-less authenticator legitimately keeps sign_count at zero, so
		// an identical update (for example, two logins in the same second) may
		// therefore report zero even though the CAS predicate matched. There is
		// no counter progression to serialize in that case; accept only the
		// exact value already stored. Non-zero counters remain strict CAS.
		if oldSignCount == 0 && credential.SignCount == 0 && webAuthnCredentialEqual(current, credential) {
			return nil
		}
		return ErrWebAuthnCredentialChanged
	}
	return nil
}

func webAuthnCredentialEqual(a, b WebAuthnCredential) bool {
	return a.ID == b.ID &&
		a.Name == b.Name &&
		bytes.Equal(a.CredentialData, b.CredentialData) &&
		a.SignCount == b.SignCount &&
		a.Created.Unix() == b.Created.Unix() &&
		unixOrZero(a.LastUsed) == unixOrZero(b.LastUsed)
}

func (s *SQLite) PutWebAuthnChallenge(challenge WebAuthnChallenge) error {
	if err := validateWebAuthnChallenge(challenge); err != nil {
		return err
	}
	return s.withOperationTx(func(tx *sql.Tx) error {
		// Serialize challenge issuance on network databases so concurrent begin
		// requests cannot all observe the capacity just below its bound. SQLite
		// already uses a single connection and the memory driver holds its mutex.
		if lock := s.dialect.TxLock(); lock != "" {
			var singleton int
			if err := tx.QueryRow(`SELECT singleton FROM auth_webauthn_user WHERE singleton = 1` + lock).Scan(&singleton); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(s.bind(`DELETE FROM auth_webauthn_challenges WHERE expires <= ?`), time.Now().Unix()); err != nil {
			return err
		}
		if _, err := tx.Exec(s.bind(`DELETE FROM auth_webauthn_challenges WHERE flow_hash = ?`), challenge.FlowHash); err != nil {
			return err
		}
		var active int
		if err := tx.QueryRow(`SELECT count(*) FROM auth_webauthn_challenges`).Scan(&active); err != nil {
			return err
		}
		if active >= webAuthnChallengeLimit {
			return ErrWebAuthnChallengeLimit
		}
		_, err := tx.Exec(s.bind(`INSERT INTO auth_webauthn_challenges(flow_hash, kind, session_data, origin, rp_id, expires) VALUES(?, ?, ?, ?, ?, ?)`), challenge.FlowHash, challenge.Kind, challenge.SessionData, challenge.Origin, challenge.RPID, challenge.Expires.Unix())
		return err
	})
}

func (s *SQLite) ConsumeWebAuthnChallenge(flowHash, kind string, now time.Time) (WebAuthnChallenge, error) {
	var challenge WebAuthnChallenge
	var expires int64
	invalid := false
	err := s.withOperationTx(func(tx *sql.Tx) error {
		if err := tx.QueryRow(s.bind(`SELECT flow_hash, kind, session_data, origin, rp_id, expires FROM auth_webauthn_challenges WHERE flow_hash = ?`), flowHash).Scan(&challenge.FlowHash, &challenge.Kind, &challenge.SessionData, &challenge.Origin, &challenge.RPID, &expires); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrWebAuthnChallenge
			}
			return err
		}
		result, err := tx.Exec(s.bind(`DELETE FROM auth_webauthn_challenges WHERE flow_hash = ?`), flowHash)
		if err != nil {
			return err
		}
		affected, err := result.RowsAffected()
		if err != nil || affected != 1 {
			return ErrWebAuthnChallenge
		}
		if challenge.Kind != kind || expires <= now.Unix() {
			invalid = true
		}
		return nil
	})
	if err != nil {
		if errors.Is(err, ErrWebAuthnChallenge) {
			return WebAuthnChallenge{}, err
		}
		return WebAuthnChallenge{}, wrapSQLError("consume WebAuthn challenge", err)
	}
	if invalid {
		return WebAuthnChallenge{}, ErrWebAuthnChallenge
	}
	challenge.Expires = time.Unix(expires, 0).UTC()
	return challenge, nil
}

func unixOrZero(value time.Time) int64 {
	if value.IsZero() {
		return 0
	}
	return value.Unix()
}
