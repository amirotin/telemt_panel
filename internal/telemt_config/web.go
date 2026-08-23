package telemt_config

import (
	"github.com/pelletier/go-toml/v2"
)

// WebProfile describes one WEB vhost profile from Telemt's config: which
// user is exposed on which public hostname and in which secret representation.
type WebProfile struct {
	Host       string `json:"host"`
	User       string `json:"user"`
	SecretMode string `json:"secret_mode"`
}

// ParseWebProfiles extracts the WEB proxy mode state (Telemt 3.5.2+) from raw
// config TOML. The Users API does not return tg://webproxy links, so the
// panel assembles them client-side from these profiles plus the user's secret.
func ParseWebProfiles(content string) (enabled bool, profiles []WebProfile, err error) {
	var doc struct {
		Web struct {
			Enabled bool `toml:"enabled"`
			Vhosts  []struct {
				Host     string `toml:"host"`
				Profiles []struct {
					User       string `toml:"user"`
					SecretMode string `toml:"secret_mode"`
				} `toml:"profiles"`
			} `toml:"vhosts"`
		} `toml:"web"`
	}
	if err := toml.Unmarshal([]byte(content), &doc); err != nil {
		return false, nil, err
	}

	for _, vhost := range doc.Web.Vhosts {
		for _, p := range vhost.Profiles {
			if vhost.Host == "" || p.User == "" {
				continue
			}
			mode := p.SecretMode
			if mode == "" {
				mode = "plain"
			}
			profiles = append(profiles, WebProfile{Host: vhost.Host, User: p.User, SecretMode: mode})
		}
	}
	return doc.Web.Enabled, profiles, nil
}
