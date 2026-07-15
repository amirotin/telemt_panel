package telegram

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
)

type apiUser struct {
	name        string
	secret      string
	totalOctets int64
	activeIPs   []string
}

var secretRe = regexp.MustCompile(`secret=ee([a-f0-9]{16,32})`)

func extractSecret(linksData interface{}) string {
	m := secretRe.FindStringSubmatch(fmt.Sprint(linksData))
	if len(m) > 1 {
		return m[1]
	}
	return ""
}

func (b *Bot) apiBase() string {
	u := b.cfg.Telemt.URL
	if !strings.HasSuffix(u, "/v1") {
		u = strings.TrimRight(u, "/") + "/v1"
	}
	return u
}

func (b *Bot) apiDo(method, endpoint string, body interface{}) (map[string]interface{}, error) {
	var bodyReader *bytes.Buffer
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		bodyReader = bytes.NewBuffer(data)
	} else {
		bodyReader = &bytes.Buffer{}
	}

	req, err := http.NewRequest(method, b.apiBase()+endpoint, bodyReader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if b.cfg.Telemt.AuthHeader != "" {
		req.Header.Set("X-Auth", b.cfg.Telemt.AuthHeader)
	}

	resp, err := b.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var result map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusConflict {
		result["_conflict"] = true
		return result, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("telemt API returned status %d", resp.StatusCode)
	}
	return result, nil
}

func (b *Bot) apiGetUsers() ([]apiUser, error) {
	resp, err := b.apiDo("GET", "/users", nil)
	if err != nil {
		return nil, err
	}
	data, _ := resp["data"].([]interface{})
	var users []apiUser
	for _, d := range data {
		m, ok := d.(map[string]interface{})
		if !ok {
			continue
		}
		u := apiUser{name: fmt.Sprint(m["username"])}
		u.secret = extractSecret(m["links"])
		if v, ok := m["total_octets"].(float64); ok {
			u.totalOctets = int64(v)
		}
		if ips, ok := m["active_unique_ips_list"].([]interface{}); ok {
			for _, ip := range ips {
				u.activeIPs = append(u.activeIPs, fmt.Sprint(ip))
			}
		}
		users = append(users, u)
	}
	return users, nil
}

// apiCreateUser creates a user and returns (ok, secret, isConflict).
func (b *Bot) apiCreateUser(name, secret string) (ok bool, realSecret string, conflict bool) {
	maxTCP := b.maxTCPConns()
	resp, err := b.apiDo("POST", "/users", map[string]interface{}{
		"username":      name,
		"secret":        secret,
		"max_tcp_conns": maxTCP,
	})
	if err != nil {
		return false, "", false
	}
	if _, isConf := resp["_conflict"]; isConf {
		users, err := b.apiGetUsers()
		if err == nil {
			for _, u := range users {
				if u.name == name {
					return true, u.secret, true
				}
			}
		}
		// Conflict but real secret is unknown — do not return the generated secret.
		return false, "", true
	}
	if ok, _ := resp["ok"].(bool); ok {
		return true, secret, false
	}
	return false, "", false
}

func (b *Bot) apiDeleteUser(name string) error {
	_, err := b.apiDo("DELETE", "/users/"+name, nil)
	return err
}

func (b *Bot) apiRotateUserSecret(name, oldSecret, newSecret string) (string, error) {
	resp, err := b.apiDo("PATCH", "/users/"+name, map[string]interface{}{
		"secret":        newSecret,
		"max_tcp_conns": b.maxTCPConns(),
	})
	if err == nil {
		if ok, hasOK := resp["ok"].(bool); hasOK && !ok {
			return "", fmt.Errorf("telemt API returned ok=false")
		}
		return newSecret, nil
	}

	if err := b.apiDeleteUser(name); err != nil {
		return "", err
	}
	ok, realSecret, _ := b.apiCreateUser(name, newSecret)
	if !ok {
		if oldSecret != "" {
			b.apiCreateUser(name, oldSecret) //nolint:errcheck
		}
		return "", fmt.Errorf("failed to recreate user after secret rotation")
	}
	return realSecret, nil
}

func formatTraffic(octets int64) string {
	const gb = 1 << 30
	const mb = 1 << 20
	if octets >= gb {
		return fmt.Sprintf("%.2f GB", float64(octets)/float64(gb))
	}
	return fmt.Sprintf("%.2f MB", float64(octets)/float64(mb))
}
