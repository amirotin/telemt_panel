package subpage

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
)

var webBasePathPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*(/[A-Za-z0-9][A-Za-z0-9_-]*)*$`)

// WebLinksForUser projects only the recipient's enabled WEB profiles.
// Path-mounted links follow Telemt 3.5.8's Telegram Desktop marker grammar.
func WebLinksForUser(raw json.RawMessage, username, secret string) []string {
	if !isHex32(secret) {
		return nil
	}
	var cfg struct {
		Enabled bool `json:"enabled"`
		Vhosts  []struct {
			Host     string   `json:"host"`
			Hosts    []string `json:"hosts"`
			BasePath string   `json:"base_path"`
			Profiles []struct {
				User string `json:"user"`
				Mode string `json:"secret_mode"`
			} `json:"profiles"`
		} `json:"vhosts"`
	}
	if json.Unmarshal(raw, &cfg) != nil || !cfg.Enabled {
		return nil
	}
	var links []string
	seen := make(map[string]bool)
	for _, vhost := range cfg.Vhosts {
		if len(vhost.BasePath) > 128 || vhost.BasePath != "" && !webBasePathPattern.MatchString(vhost.BasePath) {
			continue
		}
		hosts := vhost.Hosts
		if len(hosts) == 0 {
			hosts = []string{vhost.Host}
		}
		for _, profile := range vhost.Profiles {
			if profile.User != username || profile.Mode != "plain" && profile.Mode != "dd" {
				continue
			}
			clientSecret := secret
			if profile.Mode == "dd" {
				clientSecret = "dd" + secret
			}
			if vhost.BasePath != "" {
				rawSecret, _ := hex.DecodeString(clientSecret)
				clientSecret = base64.RawURLEncoding.EncodeToString(append([]byte{0x70}, rawSecret...))
			}
			for _, host := range hosts {
				if host == "" || strings.ContainsAny(host, " /:?#@%\\\t\r\n") {
					continue
				}
				server := host
				if vhost.BasePath != "" {
					server += "/" + vhost.BasePath
				}
				link := "tg://webproxy?server=" + url.QueryEscape(server) + "&secret=" + clientSecret
				if !seen[link] {
					links = append(links, link)
					seen[link] = true
				}
			}
		}
	}
	return links
}
