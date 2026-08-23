package subpage

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

func uintPtr(n uint64) *uint64 { return &n }

func fixtureUser() telemt.UserInfo {
	return telemt.UserInfo{
		Username:          "alice",
		Enabled:           true,
		ExpirationRFC3339: "2099-01-01T00:00:00Z",
		DataQuotaBytes:    uintPtr(10 << 30), // 10 GiB
		TotalOctets:       5 << 30,           // 5 GiB used
		Links: telemt.UserLinks{
			Classic: []string{"tg://proxy?server=1.2.3.4&port=443&secret=0123456789abcdef0123456789abcdef"},
			Secure:  []string{"tg://proxy?server=1.2.3.4&port=443&secret=ddfedcba9876543210fedcba9876543210"},
			TLS:     []string{"tg://proxy?server=1.2.3.4&port=443&secret=ee0011223344example"},
			TLSDomains: []telemt.TLSDomainLink{
				{Domain: "cdn.example.com", Link: "tg://proxy?server=1.2.3.4&port=443&secret=ee0011223344cdn"},
			},
		},
	}
}

func renderFixture(t *testing.T, acceptLanguage string) string {
	t.Helper()
	var buf bytes.Buffer
	if err := RenderPage(&buf, fixtureUser(), acceptLanguage, time.Now()); err != nil {
		t.Fatalf("RenderPage: %v", err)
	}
	return buf.String()
}

func TestRenderPageContainsTgLinkAndRawFields(t *testing.T) {
	html := renderFixture(t, "en-US")

	for _, want := range []string{
		`href="tg://proxy?server=1.2.3.4&amp;port=443&amp;secret=0123456789abcdef0123456789abcdef"`,
		`href="https://t.me/proxy?server=1.2.3.4&amp;port=443&amp;secret=0123456789abcdef0123456789abcdef"`,
		`<code>1.2.3.4</code>`,
		`<code>443</code>`,
		`<code>0123456789abcdef0123456789abcdef</code>`,
		"cdn.example.com",
		"data:image/png;base64,",
	} {
		if !strings.Contains(html, want) {
			t.Errorf("rendered page missing %q", want)
		}
	}
}

func TestRenderPageChoosesLanguageFromAcceptLanguage(t *testing.T) {
	ru := renderFixture(t, "ru-RU,ru;q=0.9")
	if !strings.Contains(ru, `<html lang="ru">`) {
		t.Error("expected Russian chrome for an Accept-Language starting with ru")
	}
	if !strings.Contains(ru, stringsRU.StatusActive) {
		t.Error("expected the Russian status label")
	}

	en := renderFixture(t, "fr-FR")
	if !strings.Contains(en, `<html lang="en">`) {
		t.Error("expected English chrome for a non-ru Accept-Language")
	}
	if !strings.Contains(en, stringsEN.StatusActive) {
		t.Error("expected the English status label")
	}

	// Both languages' manual instructions are always present, regardless
	// of which one is open by default.
	if !strings.Contains(en, instructionsRU.Heading) || !strings.Contains(en, instructionsEN.Heading) {
		t.Error("expected both RU and EN instructions to be rendered")
	}
}

func TestRenderPageStatusDisabled(t *testing.T) {
	u := fixtureUser()
	u.Enabled = false
	var buf bytes.Buffer
	if err := RenderPage(&buf, u, "en", time.Now()); err != nil {
		t.Fatalf("RenderPage: %v", err)
	}
	if !strings.Contains(buf.String(), "status-disabled") {
		t.Error("expected the disabled status to render")
	}
}

func TestRenderPageStatusExpired(t *testing.T) {
	u := fixtureUser()
	u.ExpirationRFC3339 = "2000-01-01T00:00:00Z"
	var buf bytes.Buffer
	if err := RenderPage(&buf, u, "en", time.Now()); err != nil {
		t.Fatalf("RenderPage: %v", err)
	}
	if !strings.Contains(buf.String(), "status-expired") {
		t.Error("expected the expired status to render")
	}
}

func TestRenderPageStatusQuotaExhausted(t *testing.T) {
	u := fixtureUser()
	u.TotalOctets = *u.DataQuotaBytes
	var buf bytes.Buffer
	if err := RenderPage(&buf, u, "en", time.Now()); err != nil {
		t.Fatalf("RenderPage: %v", err)
	}
	if !strings.Contains(buf.String(), "status-quota_exhausted") {
		t.Error("expected the quota_exhausted status to render")
	}
}

func TestRenderPageOmitsQuotaSectionWhenNoQuotaData(t *testing.T) {
	u := fixtureUser()
	u.DataQuotaBytes = nil
	var buf bytes.Buffer
	if err := RenderPage(&buf, u, "en", time.Now()); err != nil {
		t.Fatalf("RenderPage: %v", err)
	}
	if strings.Contains(buf.String(), `class="quota"`) {
		t.Error("did not expect a quota section when DataQuotaBytes is nil")
	}
}

func TestFormatBytes(t *testing.T) {
	cases := map[uint64]string{
		0:         "0 B",
		1023:      "1023 B",
		1024:      "1.0 KiB",
		1536:      "1.5 KiB",
		10 << 30:  "10.0 GiB",
		5<<30 + 1: "5.0 GiB",
	}
	for in, want := range cases {
		if got := formatBytes(in); got != want {
			t.Errorf("formatBytes(%d) = %q, want %q", in, got, want)
		}
	}
}
