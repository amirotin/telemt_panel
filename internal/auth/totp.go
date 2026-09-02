package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1" // RFC 6238 compatibility requires SHA-1 for TOTP.
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	TOTPSecretBytes       = 20
	TOTPPeriodSeconds     = int64(30)
	TOTPCodeDigits        = 6
	TOTPRecoveryCodeCount = 10
	TOTPSetupTTL          = 10 * time.Minute
)

var totpBase32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// GenerateTOTPSecret returns a 160-bit base32 secret suitable for RFC 6238.
func GenerateTOTPSecret() (string, error) {
	return generateTOTPSecret(rand.Reader)
}

func generateTOTPSecret(random io.Reader) (string, error) {
	secret := make([]byte, TOTPSecretBytes)
	if _, err := io.ReadFull(random, secret); err != nil {
		return "", fmt.Errorf("generate TOTP secret: %w", err)
	}
	return totpBase32.EncodeToString(secret), nil
}

// TOTPProvisioningURI builds the standard URI consumed by authenticator apps.
func TOTPProvisioningURI(issuer, account, secret string) string {
	label := url.PathEscape(issuer + ":" + account)
	query := url.Values{
		"algorithm": {"SHA1"},
		"digits":    {strconv.Itoa(TOTPCodeDigits)},
		"issuer":    {issuer},
		"period":    {strconv.FormatInt(TOTPPeriodSeconds, 10)},
		"secret":    {secret},
	}
	return "otpauth://totp/" + label + "?" + query.Encode()
}

// ValidateTOTP accepts the current 30-second timestep and one timestep on
// either side. The returned timestep is persisted atomically to reject replay.
func ValidateTOTP(secret, code string, now time.Time) (int64, bool) {
	if len(code) != TOTPCodeDigits {
		return 0, false
	}
	for _, digit := range code {
		if digit < '0' || digit > '9' {
			return 0, false
		}
	}
	decoded, err := totpBase32.DecodeString(strings.ToUpper(strings.TrimSpace(secret)))
	if err != nil || len(decoded) != TOTPSecretBytes {
		return 0, false
	}
	current := now.Unix() / TOTPPeriodSeconds
	for _, step := range []int64{current, current - 1, current + 1} {
		expected := totpCode(decoded, step, TOTPCodeDigits)
		if subtle.ConstantTimeCompare([]byte(expected), []byte(code)) == 1 {
			return step, true
		}
	}
	return 0, false
}

func totpCode(secret []byte, timestep int64, digits int) string {
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(timestep))
	mac := hmac.New(sha1.New, secret)
	_, _ = mac.Write(counter[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	value := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7fffffff
	modulus := uint32(1)
	for range digits {
		modulus *= 10
	}
	return fmt.Sprintf("%0*d", digits, value%modulus)
}

// GenerateRecoveryCodes returns ten one-time codes and their irreversible
// hashes. Only the hashes belong in the store; plaintext is shown once.
func GenerateRecoveryCodes() ([]string, [][]byte, error) {
	return generateRecoveryCodes(rand.Reader)
}

func generateRecoveryCodes(random io.Reader) ([]string, [][]byte, error) {
	codes := make([]string, 0, TOTPRecoveryCodeCount)
	hashes := make([][]byte, 0, TOTPRecoveryCodeCount)
	seen := make(map[string]struct{}, TOTPRecoveryCodeCount)
	for len(codes) < TOTPRecoveryCodeCount {
		raw := make([]byte, 7)
		if _, err := io.ReadFull(random, raw); err != nil {
			return nil, nil, fmt.Errorf("generate recovery code: %w", err)
		}
		encoded := totpBase32.EncodeToString(raw)
		if len(encoded) < 10 {
			return nil, nil, errors.New("generated recovery code is too short")
		}
		normalized := encoded[:10]
		if _, duplicate := seen[normalized]; duplicate {
			continue
		}
		seen[normalized] = struct{}{}
		codes = append(codes, normalized[:5]+"-"+normalized[5:])
		hash := RecoveryCodeHash(normalized)
		hashes = append(hashes, hash[:])
	}
	return codes, hashes, nil
}

// RecoveryCodeHash normalizes case, spaces and separators before hashing.
func RecoveryCodeHash(code string) [sha256.Size]byte {
	normalized := strings.ToUpper(strings.TrimSpace(code))
	normalized = strings.NewReplacer("-", "", " ", "").Replace(normalized)
	return sha256.Sum256([]byte("telemt-panel-recovery-v1\x00" + normalized))
}
