package telemt_config

import "testing"

func TestParseWebProfiles(t *testing.T) {
	content := `
[general.links]
show = ["web-user"]

[web]
enabled = true
carrier = "https-lanes"

[[web.vhosts]]
host = "proxy.example.com"
public_addr = "203.0.113.10:443"

[[web.vhosts.profiles]]
user = "web-user"
secret_mode = "dd"
max_sessions = 8

[[web.vhosts.profiles]]
user = "alice"
secret_mode = "plain"

[[web.vhosts]]
host = "second.example.net"

[[web.vhosts.profiles]]
user = "web-user"
secret_mode = "plain"
`
	enabled, profiles, err := ParseWebProfiles(content)
	if err != nil {
		t.Fatal(err)
	}
	if !enabled {
		t.Error("expected web.enabled = true")
	}
	want := []WebProfile{
		{Host: "proxy.example.com", User: "web-user", SecretMode: "dd"},
		{Host: "proxy.example.com", User: "alice", SecretMode: "plain"},
		{Host: "second.example.net", User: "web-user", SecretMode: "plain"},
	}
	if len(profiles) != len(want) {
		t.Fatalf("got %d profiles, want %d: %+v", len(profiles), len(want), profiles)
	}
	for i, w := range want {
		if profiles[i] != w {
			t.Errorf("profile[%d] = %+v, want %+v", i, profiles[i], w)
		}
	}
}

func TestParseWebProfilesAbsentSection(t *testing.T) {
	enabled, profiles, err := ParseWebProfiles("[general]\nuse_middle_proxy = true\n")
	if err != nil || enabled || len(profiles) != 0 {
		t.Errorf("expected empty result for config without [web], got enabled=%v profiles=%v err=%v", enabled, profiles, err)
	}
}
