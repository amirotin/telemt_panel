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
	if err := RenderPage(&buf, fixtureUser(), nil, acceptLanguage, time.Now()); err != nil {
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
	if err := RenderPage(&buf, u, nil, "en", time.Now()); err != nil {
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
	if err := RenderPage(&buf, u, nil, "en", time.Now()); err != nil {
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
	if err := RenderPage(&buf, u, nil, "en", time.Now()); err != nil {
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
	if err := RenderPage(&buf, u, nil, "en", time.Now()); err != nil {
		t.Fatalf("RenderPage: %v", err)
	}
	if strings.Contains(buf.String(), `class="quota"`) {
		t.Error("did not expect a quota section when DataQuotaBytes is nil")
	}
}

// TestRenderPageUsesQuotaEntryUsedBytesOverTotalOctets covers finding 4: a
// non-nil quota entry (from telemt.Client.QuotaList) must win over u's
// lifetime TotalOctets, both for the usage figure shown and for whether
// the user is deemed quota_exhausted — otherwise a user reset via POST
// reset-quota keeps showing exhausted forever, since TotalOctets never
// resets.
func TestRenderPageUsesQuotaEntryUsedBytesOverTotalOctets(t *testing.T) {
	u := fixtureUser()
	u.TotalOctets = *u.DataQuotaBytes // lifetime counter says "exhausted"

	entry := &telemt.QuotaEntry{
		DataQuotaBytes:     *u.DataQuotaBytes,
		UsedBytes:          1 << 30, // 1 GiB since the reset — well under quota
		LastResetEpochSecs: 1700000000,
	}

	var buf bytes.Buffer
	if err := RenderPage(&buf, u, entry, "en", time.Now()); err != nil {
		t.Fatalf("RenderPage: %v", err)
	}
	html := buf.String()

	// The stylesheet's selector list mentions "status-quota_exhausted"
	// unconditionally, so the check must match the span's own class
	// attribute, not just any substring of the page.
	if strings.Contains(html, `class="status status-quota_exhausted"`) {
		t.Error("expected the quota entry's used_bytes, not lifetime TotalOctets, to decide quota_exhausted")
	}
	if !strings.Contains(html, `class="status status-active"`) {
		t.Errorf("expected an active status; body = %s", html)
	}
	if !strings.Contains(html, formatBytes(entry.UsedBytes)) {
		t.Errorf("expected the quota entry's used_bytes (%s) in the page; body = %s", formatBytes(entry.UsedBytes), html)
	}
	wantReset := time.Unix(entry.LastResetEpochSecs, 0).UTC().Format("2006-01-02 15:04 MST")
	if !strings.Contains(html, wantReset) {
		t.Errorf("expected the reset date %q in the page; body = %s", wantReset, html)
	}
}

// TestRenderPageQuotaFallsBackToTotalOctetsWithoutEntry covers the
// degraded path (older Telemt build without the quota-list capability, or
// no entry for this user): with quota == nil the page must still render
// using u.TotalOctets, exactly as before this fix, and show no reset date.
func TestRenderPageQuotaFallsBackToTotalOctetsWithoutEntry(t *testing.T) {
	u := fixtureUser()
	var buf bytes.Buffer
	if err := RenderPage(&buf, u, nil, "en", time.Now()); err != nil {
		t.Fatalf("RenderPage: %v", err)
	}
	html := buf.String()
	if !strings.Contains(html, formatBytes(u.TotalOctets)) {
		t.Errorf("expected TotalOctets (%s) in the page as a fallback; body = %s", formatBytes(u.TotalOctets), html)
	}
	if strings.Contains(html, "QuotaResetLabel") || strings.Contains(html, stringsEN.QuotaResetLabel+":") {
		t.Error("did not expect a reset date without a quota entry")
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
