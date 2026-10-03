package subpage

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

func TestWebLinksForUserMatchesTelemt358(t *testing.T) {
	for _, tc := range []struct{ mode, encoded string }{{"plain", "cAABAgMEBQYHCAkKCwwNDg8"}, {"dd", "cN0AAQIDBAUGBwgJCgsMDQ4P"}} {
		raw := json.RawMessage(`{"enabled":true,"vhosts":[{"host":"proxy.example.com","base_path":"dobry-cola/super_app","profiles":[{"user":"bob","secret_mode":"plain"},{"user":"alice","secret_mode":"` + tc.mode + `"}]}]}`)
		links := WebLinksForUser(raw, "alice", "000102030405060708090a0b0c0d0e0f")
		want := "tg://webproxy?server=proxy.example.com%2Fdobry-cola%2Fsuper_app&secret=" + tc.encoded
		if len(links) != 1 || links[0] != want {
			t.Fatalf("%s links=%v, want one reference URL", tc.mode, links)
		}
	}
}

func TestWebLinksForUserKeepsRootAndFiltersUnsafeInputs(t *testing.T) {
	secret := "000102030405060708090a0b0c0d0e0f"
	root := json.RawMessage(`{"enabled":true,"vhosts":[{"host":"proxy.example.com","profiles":[{"user":"alice","secret_mode":"dd"},{"user":"bob","secret_mode":"plain"}]}]}`)
	links := WebLinksForUser(root, "alice", secret)
	if len(links) != 1 || links[0] != "tg://webproxy?server=proxy.example.com&secret=dd"+secret {
		t.Fatalf("root compatibility lost: %v", links)
	}
	for _, raw := range []string{
		`{"enabled":false,"vhosts":[{"host":"proxy.example.com","profiles":[{"user":"alice","secret_mode":"plain"}]}]}`,
		`{"enabled":true,"vhosts":[{"host":"proxy.example.com","base_path":"/bad","profiles":[{"user":"alice","secret_mode":"plain"}]}]}`,
		`{"enabled":true,"vhosts":[{"host":"bad.example/path","profiles":[{"user":"alice","secret_mode":"plain"}]}]}`,
		`{"enabled":true,"vhosts":[{"host":"proxy.example.com","profiles":[{"user":"bob","secret_mode":"plain"}]}]}`,
	} {
		if got := WebLinksForUser(json.RawMessage(raw), "alice", secret); len(got) != 0 {
			t.Fatalf("unexpected public links from invalid/disabled/unassigned WEB: %v", got)
		}
	}
}

func TestRenderPageIncludesWebWithoutInventingTMeOrPort(t *testing.T) {
	var out bytes.Buffer
	link := "tg://webproxy?server=proxy.example.com%2FRelay&secret=cAABAgMEBQYHCAkKCwwNDg8"
	if err := RenderPage(&out, telemt.UserInfo{Username: "alice", Enabled: true}, nil, "ru", time.Now(), link); err != nil {
		t.Fatal(err)
	}
	html := out.String()
	if !strings.Contains(html, `tg://webproxy?`) || !strings.Contains(html, "WEB") || !strings.Contains(html, "data:image/png;base64,") {
		t.Fatal("WEB subscription card/QR missing")
	}
	if strings.Contains(html, "https://t.me/") || strings.Contains(html, ">Порт</dt>") {
		t.Fatal("WEB has no t.me or standalone port")
	}
	if strings.Contains(html, ">Ссылки для подключения недоступны.") {
		t.Fatal("WEB-only page must not show no-links state")
	}
}
