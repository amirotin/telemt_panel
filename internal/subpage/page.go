package subpage

import (
	"encoding/base64"
	"fmt"
	"html/template"
	"io"
	"log/slog"
	"net/url"
	"strings"
	"time"

	"github.com/amirotin/telemt_panel/internal/telemt"
	qrcode "github.com/skip2/go-qrcode"
)

// qrSize is the QR code's pixel width/height (spec: 256px).
const qrSize = 256

// pageData is the subpage template's root data model.
type pageData struct {
	Lang           string
	S              uiStrings
	InstructionsRU instructions
	InstructionsEN instructions

	Username string
	// Initial is Username's first rune, upper-cased — the letter the
	// header's avatar tile shows (the prototype's subscription artboard).
	// Rune-wise, not byte-wise, so a non-ASCII username still renders one
	// whole character.
	Initial string
	Status  statusView
	Quota   *quotaView
	Expiry  *expiryView
	Groups  []linkGroupView
}

type statusView struct {
	Key   string // "active" | "disabled" | "expired" | "quota_exhausted"
	Label string
}

type quotaView struct {
	Percent    int
	UsedHuman  string
	TotalHuman string
	ResetHuman string // "" when the last-reset date isn't known
}

type expiryView struct {
	Formatted string
}

type linkGroupView struct {
	Title    string
	Variants []linkVariantView
}

// linkVariantView is one connectable link (a TLS domain, or the single
// secure/classic link) with its raw fields and QR code. TgURL, TMeURL and
// QRDataURI are template.URL, not string: they hold server-built content
// (Telemt's own links, or a data: URI we encoded ourselves) that
// html/template's URL sanitizer would otherwise mangle — tg:// and data:
// are not on its default safe-scheme allowlist. None of this is
// user-supplied input.
type linkVariantView struct {
	Domain    string
	TgURL     template.URL
	TMeURL    template.URL
	Server    string
	Port      string
	Secret    string
	QRDataURI template.URL
}

// RenderPage renders u's subscription page to w, choosing RU or EN chrome
// strings from acceptLanguage (both languages' manual-setup instructions
// are always rendered — see the template). quota is u's entry from
// telemt.Client.QuotaList, or nil when that capability is absent on this
// Telemt build or u has no entry there; when non-nil its UsedBytes is
// preferred over u.TotalOctets for both the quota bar and the
// quota_exhausted status, since TotalOctets is a lifetime counter that a
// quota reset does not affect (u.TotalOctets alone would keep showing
// "quota exhausted" forever after a reset).
func RenderPage(w io.Writer, u telemt.UserInfo, quota *telemt.QuotaEntry, acceptLanguage string, now time.Time) error {
	lang := detectLanguage(acceptLanguage)
	data, err := buildPageData(u, quota, lang, now)
	if err != nil {
		return err
	}
	return pageTemplate.Execute(w, data)
}

// detectLanguage implements the brief's rule verbatim: an Accept-Language
// value starting with "ru" selects Russian, anything else selects
// English. No q-value or multi-tag parsing — deliberately simple.
func detectLanguage(acceptLanguage string) string {
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(acceptLanguage)), "ru") {
		return "ru"
	}
	return "en"
}

func buildPageData(u telemt.UserInfo, quota *telemt.QuotaEntry, lang string, now time.Time) (pageData, error) {
	s := stringsEN
	if lang == "ru" {
		s = stringsRU
	}

	groups, err := buildGroups(u.Username, u.Links, s)
	if err != nil {
		return pageData{}, err
	}

	return pageData{
		Lang:           lang,
		S:              s,
		InstructionsRU: instructionsRU,
		InstructionsEN: instructionsEN,
		Username:       u.Username,
		Initial:        firstInitial(u.Username),
		Status:         buildStatus(u, quota, s, now),
		Quota:          buildQuota(u, quota),
		Expiry:         buildExpiry(u, now),
		Groups:         groups,
	}, nil
}

// quotaUsedBytes reports how much of u's quota is used, preferring
// quota.UsedBytes (reset-aware) over u.TotalOctets (a lifetime counter a
// quota reset never clears) whenever a quota entry is available.
func quotaUsedBytes(u telemt.UserInfo, quota *telemt.QuotaEntry) uint64 {
	if quota != nil {
		return quota.UsedBytes
	}
	return u.TotalOctets
}

// firstInitial returns the first rune of name, upper-cased, or "?" for an
// empty name — display-only, for the header avatar tile.
func firstInitial(name string) string {
	for _, r := range name {
		return strings.ToUpper(string(r))
	}
	return "?"
}

func buildStatus(u telemt.UserInfo, quota *telemt.QuotaEntry, s uiStrings, now time.Time) statusView {
	if !u.Enabled {
		return statusView{Key: "disabled", Label: s.StatusDisabled}
	}
	if exp, ok := parseExpiry(u.ExpirationRFC3339); ok && !now.Before(exp) {
		return statusView{Key: "expired", Label: s.StatusExpired}
	}
	if u.DataQuotaBytes != nil && quotaUsedBytes(u, quota) >= *u.DataQuotaBytes {
		return statusView{Key: "quota_exhausted", Label: s.StatusQuotaExhausted}
	}
	return statusView{Key: "active", Label: s.StatusActive}
}

// buildQuota returns nil when Telemt hasn't reported a quota for this
// user (DataQuotaBytes omitted) — there's nothing to bar-chart. The reset
// date renders only when quota is non-nil and carries one (Telemt's plain
// UserInfo has no quota-reset date at all; the quota-list entry does, once
// the user has been reset at least once — LastResetEpochSecs is 0 until
// then).
func buildQuota(u telemt.UserInfo, quota *telemt.QuotaEntry) *quotaView {
	if u.DataQuotaBytes == nil {
		return nil
	}
	total := *u.DataQuotaBytes
	used := quotaUsedBytes(u, quota)
	v := &quotaView{
		Percent:    quotaPercent(used, total),
		UsedHuman:  formatBytes(used),
		TotalHuman: formatBytes(total),
	}
	if quota != nil && quota.LastResetEpochSecs > 0 {
		v.ResetHuman = time.Unix(quota.LastResetEpochSecs, 0).UTC().Format("2006-01-02 15:04 MST")
	}
	return v
}

func buildExpiry(u telemt.UserInfo, now time.Time) *expiryView {
	exp, ok := parseExpiry(u.ExpirationRFC3339)
	if !ok {
		return nil
	}
	return &expiryView{Formatted: exp.Format("2006-01-02 15:04 MST")}
}

func parseExpiry(rfc3339 string) (time.Time, bool) {
	if rfc3339 == "" {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339, rfc3339)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

func quotaPercent(used, total uint64) int {
	if total == 0 {
		return 100
	}
	p := int((float64(used) / float64(total)) * 100)
	if p > 100 {
		p = 100
	}
	if p < 0 {
		p = 0
	}
	return p
}

// formatBytes renders n as a human-readable binary size, e.g. "1.5 GiB".
func formatBytes(n uint64) string {
	units := [...]string{"B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"}
	if n < 1024 {
		return fmt.Sprintf("%d %s", n, units[0])
	}
	val := float64(n)
	i := 0
	for val >= 1024 && i < len(units)-1 {
		val /= 1024
		i++
	}
	return fmt.Sprintf("%.1f %s", val, units[i])
}

// buildGroups builds the tls / secure / classic connect sections in that
// order (design doc 04-subpage.md), skipping any link this panel can't
// parse into server/port/secret (logged, not fatal — Telemt is the source
// of truth and a malformed link there shouldn't take down the whole page).
// username is only for those log lines — never anything from the link
// itself, which carries the user's connection secret.
func buildGroups(username string, links telemt.UserLinks, s uiStrings) ([]linkGroupView, error) {
	var groups []linkGroupView

	var tlsVariants []linkVariantView
	for i, link := range links.TLS {
		v, ok, err := buildVariant(username, "tls", i, link, "")
		if err != nil {
			return nil, err
		}
		if ok {
			tlsVariants = append(tlsVariants, v)
		}
	}
	for i, d := range links.TLSDomains {
		v, ok, err := buildVariant(username, "tls_domain", i, d.Link, d.Domain)
		if err != nil {
			return nil, err
		}
		if ok {
			tlsVariants = append(tlsVariants, v)
		}
	}
	if len(tlsVariants) > 0 {
		groups = append(groups, linkGroupView{Title: s.GroupTLS, Variants: tlsVariants})
	}

	if g, err := buildSimpleGroup(username, "secure", links.Secure, s.GroupSecure); err != nil {
		return nil, err
	} else if g != nil {
		groups = append(groups, *g)
	}

	if g, err := buildSimpleGroup(username, "classic", links.Classic, s.GroupClassic); err != nil {
		return nil, err
	} else if g != nil {
		groups = append(groups, *g)
	}

	return groups, nil
}

func buildSimpleGroup(username, kind string, links []string, title string) (*linkGroupView, error) {
	var variants []linkVariantView
	for i, link := range links {
		v, ok, err := buildVariant(username, kind, i, link, "")
		if err != nil {
			return nil, err
		}
		if ok {
			variants = append(variants, v)
		}
	}
	if len(variants) == 0 {
		return nil, nil
	}
	return &linkGroupView{Title: title, Variants: variants}, nil
}

// buildVariant parses one tg://proxy link into a display variant. The
// bool is false (not an error) when the link is missing server/port/secret
// query params — defensive against an unexpected Telemt link shape.
// kind and index identify which link this is in the log lines below
// without ever logging the link itself or the connection secret it embeds
// (url.Error, in particular, echoes the raw unparseable input verbatim).
func buildVariant(username, kind string, index int, tgLink, domain string) (linkVariantView, bool, error) {
	u, err := url.Parse(tgLink)
	if err != nil {
		slog.Warn("subpage: unparseable link", "username", username, "kind", kind, "index", index)
		return linkVariantView{}, false, nil
	}
	q := u.Query()
	server, port, secret := q.Get("server"), q.Get("port"), q.Get("secret")
	if server == "" || port == "" || secret == "" {
		slog.Warn("subpage: link missing server/port/secret", "username", username, "kind", kind, "index", index)
		return linkVariantView{}, false, nil
	}

	qr, err := qrDataURI(tgLink)
	if err != nil {
		return linkVariantView{}, false, fmt.Errorf("subpage: render QR: %w", err)
	}

	return linkVariantView{
		Domain:    domain,
		TgURL:     template.URL(tgLink),
		TMeURL:    template.URL("https://t.me/proxy?" + u.RawQuery),
		Server:    server,
		Port:      port,
		Secret:    secret,
		QRDataURI: template.URL(qr),
	}, true, nil
}

// qrDataURI renders content as a PNG QR code and returns it as a data:
// URI suitable for an <img src>.
func qrDataURI(content string) (string, error) {
	png, err := qrcode.Encode(content, qrcode.Medium, qrSize)
	if err != nil {
		return "", err
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(png), nil
}
