package subpage

import (
	"bytes"
	"errors"
	"html/template"
	"io"
	"os"
	"reflect"
	"testing"
	"time"
)

func probeLegacy(t testing.TB) *template.Template {
	t.Helper()
	source, err := os.ReadFile("testdata/page.legacy.html.tmpl")
	if err != nil {
		t.Fatal(err)
	}
	return template.Must(template.New("page").Parse(string(source)))
}

type probeLegacyVariant struct {
	Domain    string
	TgURL     template.URL
	TMeURL    template.URL
	Server    string
	Port      string
	Secret    string
	QRDataURI template.URL
	Web       bool
}
type probeLegacyGroup struct {
	Title    string
	Variants []probeLegacyVariant
}
type probeLegacyPage struct {
	Lang           string
	S              uiStrings
	InstructionsRU instructions
	InstructionsEN instructions
	Username       string
	Initial        string
	Status         statusView
	Quota          *quotaView
	Expiry         *expiryView
	Groups         []probeLegacyGroup
}

// Struct fields and URL types mirror the production legacy model for fair comparison.
func probeLegacyData(d pageData) any {
	groups := make([]probeLegacyGroup, 0, len(d.Groups))
	for _, g := range d.Groups {
		variants := make([]probeLegacyVariant, 0, len(g.Variants))
		for _, v := range g.Variants {
			variants = append(variants, probeLegacyVariant{v.Domain, template.URL(v.TgURL), template.URL(v.TMeURL), v.Server, v.Port, v.Secret, template.URL(v.QRDataURI), v.Web})
		}
		groups = append(groups, probeLegacyGroup{g.Title, variants})
	}
	return probeLegacyPage{d.Lang, d.S, d.InstructionsRU, d.InstructionsEN, d.Username, d.Initial, d.Status, d.Quota, d.Expiry, groups}
}

func TestRenderPageDataMatchesLegacy(t *testing.T) {
	legacy := probeLegacy(t)
	now := time.Date(2026, 10, 6, 0, 0, 0, 0, time.UTC)
	var cases []pageData
	for _, lang := range []string{"ru", "en"} {
		for _, status := range []string{"active", "disabled", "expired", "quota_exhausted"} {
			for _, percent := range []int{-1, 0, 79, 80, 99, 100, 101} {
				d, err := buildPageData(fixtureUser(), nil, lang, now, "tg://webproxy?server=example.com%2FRelay&secret=cAABAgMEBQYHCAkKCwwNDg8")
				if err != nil {
					t.Fatal(err)
				}
				d.Status.Key = status
				d.Quota.Percent = percent
				cases = append(cases, d)
				d.Quota = nil
				d.Expiry = nil
				d.Groups = nil
				cases = append(cases, d)
			}
		}
	}
	for _, weird := range []string{"<>&\"'+", "A\x00B", "Кириллица 日本語 😀", "x\xff\xfe", "</script><img src=x onerror=alert(1)>"} {
		d, err := buildPageData(fixtureUser(), nil, "en", now)
		if err != nil {
			t.Fatal(err)
		}
		d.Username = weird
		d.Initial = weird
		d.Status.Label = weird
		fields := reflect.ValueOf(&d.S).Elem()
		for i := 0; i < fields.NumField(); i++ {
			if fields.Field(i).Kind() == reflect.String {
				fields.Field(i).SetString(weird)
			}
		}
		d.Quota.UsedHuman = weird
		d.Quota.TotalHuman = weird
		d.Quota.ResetHuman = weird
		d.Expiry.Formatted = weird
		d.Groups = []linkGroupView{{Title: weird, Variants: []linkVariantView{{Domain: weird, Server: weird, Port: weird, Secret: weird, TgURL: "tg://proxy?server=x&port=443&secret=" + weird, TMeURL: "https://t.me/proxy?server=" + weird, QRDataURI: "data:image/png;base64,A+/=", Web: true}}}}
		cases = append(cases, d)
	}
	for i, d := range cases {
		var want, got bytes.Buffer
		if err := legacy.Execute(&want, probeLegacyData(d)); err != nil {
			t.Fatal(err)
		}
		if err := renderPageData(&got, d); err != nil {
			t.Fatal(err)
		}
		if got.String() != want.String() {
			a, b := got.String(), want.String()
			offset := 0
			for offset < len(a) && offset < len(b) && a[offset] == b[offset] {
				offset++
			}
			endA, endB := min(offset+150, len(a)), min(offset+150, len(b))
			start := max(0, offset-50)
			t.Fatalf("case %d first difference %d; got len %d want len %d\ngot %q\nwant %q", i, offset, len(a), len(b), a[start:endA], b[start:endB])
		}
	}
	t.Logf("byte-identical cases: %d", len(cases))
}

func TestRenderPageDataEscaping(t *testing.T) {
	htmlRef := template.Must(template.New("html").Parse(`<a title="{{.}}">{{.}}</a>`))
	urlRef := template.Must(template.New("url").Parse(`<a href="{{.}}">x</a>`))
	cases := []string{"", "abc", "<>&\"'+", "\x00", "abc%20def%2G%", "tg://proxy?server=тест.рф&secret=a+b/==", "'() !#$&*+,/:;=?@[]-._~"}
	for c := 0; c < 256; c++ {
		cases = append(cases, "p"+string([]byte{byte(c)})+"q")
	}
	for _, s := range cases {
		var want bytes.Buffer
		if err := htmlRef.Execute(&want, s); err != nil {
			t.Fatal(err)
		}
		safe := pageHTMLEscaper.Replace(s)
		got := `<a title="` + safe + `">` + safe + `</a>`
		if got != want.String() {
			t.Fatalf("HTML mismatch %q", s)
		}
		want.Reset()
		if err := urlRef.Execute(&want, template.URL(s)); err != nil {
			t.Fatal(err)
		}
		got = `<a href="` + pageHTMLEscaper.Replace(normalizePageURL(s)) + `">x</a>`
		if got != want.String() {
			t.Fatalf("URL mismatch %q: %q != %q", s, got, want.String())
		}
	}
}

func BenchmarkRenderPageData(b *testing.B) {
	d, err := buildPageData(fixtureUser(), nil, "ru", time.Date(2026, 10, 6, 0, 0, 0, 0, time.UTC))
	if err != nil {
		b.Fatal(err)
	}
	legacy := probeLegacy(b)
	adapted := probeLegacyData(d)
	b.Run("legacy", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			if err := legacy.Execute(io.Discard, adapted); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("typed", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			if err := renderPageData(io.Discard, d); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("legacy_buffered", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			var buf bytes.Buffer
			if err := legacy.Execute(&buf, adapted); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("typed_buffered", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			var buf bytes.Buffer
			if err := renderPageData(&buf, d); err != nil {
				b.Fatal(err)
			}
		}
	})
}

type failingPageWriter struct{ short bool }

func (w failingPageWriter) Write(p []byte) (int, error) {
	if w.short {
		return len(p) / 2, nil
	}
	return 0, io.ErrClosedPipe
}

func TestRenderPageWriterErrors(t *testing.T) {
	for _, short := range []bool{false, true} {
		want := io.ErrClosedPipe
		if short {
			want = io.ErrShortWrite
		}
		err := RenderPage(failingPageWriter{short}, fixtureUser(), nil, "en", time.Now())
		if !errors.Is(err, want) {
			t.Errorf("short=%v: error=%v, want %v", short, err, want)
		}
	}
}
