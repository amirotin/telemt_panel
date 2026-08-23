package subpage

import (
	"strings"
	"testing"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

// TestDeriveTokenVector pins deriveToken's output against independently
// computed HMAC-SHA256/base32 vectors, so a future refactor can't silently
// change the wire format (every previously issued subpage link would
// break).
func TestDeriveTokenVector(t *testing.T) {
	const secret = "test-panel-secret"
	const username = "alice"
	const userSecret = "0123456789abcdef0123456789abcdef"

	cases := []struct {
		name  string
		nonce string
		want  string
	}{
		{"empty nonce", "", "no4r6wfouhwafs6pjjs4byes4weh6pss"},
		{"with nonce", "abc123nonce", "y2fw37rftuvtqmpcimvl5z32zhscraal"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := deriveToken([]byte(secret), username, userSecret, c.nonce)
			if got != c.want {
				t.Fatalf("deriveToken() = %q, want %q", got, c.want)
			}
		})
	}
}

func TestDeriveTokenIsLowercaseAndUnpadded(t *testing.T) {
	token := deriveToken([]byte("s"), "user", "0123456789abcdef0123456789abcdef", "")
	if token != strings.ToLower(token) {
		t.Fatalf("token %q is not lowercase", token)
	}
	if strings.Contains(token, "=") {
		t.Fatalf("token %q contains base32 padding", token)
	}
}

func TestDeriveTokenChangesWithInputs(t *testing.T) {
	base := deriveToken([]byte("secret"), "alice", "0123456789abcdef0123456789abcdef", "")
	byUsername := deriveToken([]byte("secret"), "bob", "0123456789abcdef0123456789abcdef", "")
	bySecret := deriveToken([]byte("secret"), "alice", "fedcba9876543210fedcba9876543210", "")
	byNonce := deriveToken([]byte("secret"), "alice", "0123456789abcdef0123456789abcdef", "n1")
	byPanelSecret := deriveToken([]byte("other"), "alice", "0123456789abcdef0123456789abcdef", "")

	for name, got := range map[string]string{
		"username":     byUsername,
		"user secret":  bySecret,
		"nonce":        byNonce,
		"panel secret": byPanelSecret,
	} {
		if got == base {
			t.Errorf("changing %s did not change the token", name)
		}
	}
}

func TestExtractSecretPrefersClassicLink(t *testing.T) {
	links := telemt.UserLinks{
		Classic: []string{"tg://proxy?server=1.2.3.4&port=443&secret=0123456789abcdef0123456789abcdef"},
		Secure:  []string{"tg://proxy?server=1.2.3.4&port=443&secret=ddfedcba9876543210fedcba9876543210"},
	}
	secret, ok := ExtractSecret(links)
	if !ok {
		t.Fatal("expected a secret")
	}
	if secret != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("secret = %q, want the classic link's raw secret", secret)
	}
}

func TestExtractSecretFallsBackToSecureLinkStrippingDDPrefix(t *testing.T) {
	links := telemt.UserLinks{
		Secure: []string{"tg://proxy?server=1.2.3.4&port=443&secret=ddfedcba9876543210fedcba9876543210"},
	}
	secret, ok := ExtractSecret(links)
	if !ok {
		t.Fatal("expected a secret")
	}
	if secret != "fedcba9876543210fedcba9876543210" {
		t.Fatalf("secret = %q, want the secure link's secret with the dd prefix stripped", secret)
	}
}

func TestExtractSecretNoLinks(t *testing.T) {
	if _, ok := ExtractSecret(telemt.UserLinks{}); ok {
		t.Fatal("expected no secret when there are no links")
	}
}

func TestExtractSecretRejectsMalformedSecret(t *testing.T) {
	// Classic secret too short and not valid hex; secure secret without
	// the required dd prefix (so after stripping nothing changes and the
	// length is wrong) — neither should be accepted.
	links := telemt.UserLinks{
		Classic: []string{"tg://proxy?server=1.2.3.4&port=443&secret=nothex"},
		Secure:  []string{"tg://proxy?server=1.2.3.4&port=443&secret=zzfedcba9876543210fedcba9876543210"},
	}
	if _, ok := ExtractSecret(links); ok {
		t.Fatal("expected no secret from malformed links")
	}
}
