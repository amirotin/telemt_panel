package auth

import (
	"bytes"
	"encoding/base32"
	"net/url"
	"testing"
	"time"
)

func TestTOTPCodeRFC6238Vectors(t *testing.T) {
	secret := []byte("12345678901234567890")
	tests := []struct {
		unix int64
		code string
	}{
		{59, "94287082"},
		{1111111109, "07081804"},
		{1111111111, "14050471"},
		{1234567890, "89005924"},
		{2000000000, "69279037"},
		{20000000000, "65353130"},
	}
	for _, test := range tests {
		if got := totpCode(secret, test.unix/TOTPPeriodSeconds, 8); got != test.code {
			t.Errorf("totpCode(%d) = %s, want %s", test.unix, got, test.code)
		}
	}
}

func TestValidateTOTPWindowAndInput(t *testing.T) {
	secretBytes := []byte("12345678901234567890")
	secret := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(secretBytes)
	now := time.Unix(1_700_000_000, 0)
	current := now.Unix() / TOTPPeriodSeconds
	for _, step := range []int64{current - 1, current, current + 1} {
		code := totpCode(secretBytes, step, TOTPCodeDigits)
		got, ok := ValidateTOTP(secret, code, now)
		if !ok || got != step {
			t.Fatalf("ValidateTOTP step = %d, %v; want %d, true", got, ok, step)
		}
	}
	for _, code := range []string{"", "12345", "1234567", "12345x"} {
		if _, ok := ValidateTOTP(secret, code, now); ok {
			t.Errorf("ValidateTOTP accepted malformed code %q", code)
		}
	}
}

func TestGenerateTOTPSecretAndProvisioningURI(t *testing.T) {
	secret, err := generateTOTPSecret(bytes.NewReader(make([]byte, TOTPSecretBytes)))
	if err != nil || len(secret) != 32 {
		t.Fatalf("generateTOTPSecret = %q, %v", secret, err)
	}
	uri := TOTPProvisioningURI("Telemt Panel", "admin@example", secret)
	parsed, err := url.Parse(uri)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Scheme != "otpauth" || parsed.Host != "totp" || parsed.Query().Get("secret") != secret || parsed.Query().Get("digits") != "6" || parsed.Query().Get("period") != "30" {
		t.Fatalf("provisioning URI = %s", uri)
	}
}

func TestRecoveryCodesAreUniqueNormalizedAndHashed(t *testing.T) {
	random := bytes.Repeat([]byte{0x42}, 7*TOTPRecoveryCodeCount)
	// Make each deterministic 7-byte block unique.
	for i := 0; i < TOTPRecoveryCodeCount; i++ {
		random[i*7] = byte(i)
	}
	codes, hashes, err := generateRecoveryCodes(bytes.NewReader(random))
	if err != nil {
		t.Fatal(err)
	}
	if len(codes) != TOTPRecoveryCodeCount || len(hashes) != TOTPRecoveryCodeCount {
		t.Fatalf("codes=%d hashes=%d", len(codes), len(hashes))
	}
	seen := make(map[string]struct{})
	for i, code := range codes {
		if len(code) != 11 || code[5] != '-' {
			t.Errorf("code %q has unexpected format", code)
		}
		if _, ok := seen[code]; ok {
			t.Fatalf("duplicate recovery code %q", code)
		}
		seen[code] = struct{}{}
		hash := RecoveryCodeHash(code)
		if !bytes.Equal(hash[:], hashes[i]) {
			t.Errorf("hash mismatch for %q", code)
		}
		lowerWithSpaces := " " + code[:5] + " " + code[6:] + " "
		if other := RecoveryCodeHash(lowerWithSpaces); other != hash {
			t.Errorf("normalization mismatch for %q", code)
		}
	}
}
