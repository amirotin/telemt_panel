package config

import (
	"os"
	"testing"
)

func TestLoadWithoutUsersSection(t *testing.T) {
	toml := `
listen = "0.0.0.0:8080"
[telemt]
url = "http://127.0.0.1:9091"
auth_header = "test"
[auth]
username = "admin"
password_hash = "$2a$10$abcdefghijklmnopqrstuvwxABCDEFGHIJ"
jwt_secret = "test-secret-that-is-at-least-32-characters"
`
	f, err := os.CreateTemp("", "config-*.toml")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(f.Name())
	f.WriteString(toml)
	f.Close()

	cfg, err := Load(f.Name())
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	// All user defaults should be zero values
	if cfg.Users.DefaultSecret != "" {
		t.Errorf("DefaultSecret = %q, want empty", cfg.Users.DefaultSecret)
	}
	if cfg.Users.DefaultMaxTcpConns != 0 {
		t.Errorf("DefaultMaxTcpConns = %d, want 0", cfg.Users.DefaultMaxTcpConns)
	}
	if cfg.Users.DefaultDataQuotaBytes != 0 {
		t.Errorf("DefaultDataQuotaBytes = %d, want 0", cfg.Users.DefaultDataQuotaBytes)
	}
	if cfg.Users.DefaultMaxUniqueIps != 0 {
		t.Errorf("DefaultMaxUniqueIps = %d, want 0", cfg.Users.DefaultMaxUniqueIps)
	}
	if cfg.Users.DefaultExpiration != "" {
		t.Errorf("DefaultExpiration = %q, want empty", cfg.Users.DefaultExpiration)
	}
}

func TestLoadWithUsersSection(t *testing.T) {
	toml := `
listen = "0.0.0.0:8080"
[telemt]
url = "http://127.0.0.1:9091"
auth_header = "test"
[auth]
username = "admin"
password_hash = "$2a$10$abcdefghijklmnopqrstuvwxABCDEFGHIJ"
jwt_secret = "test-secret-that-is-at-least-32-characters"
[users]
default_secret = "abcdef1234567890abcdef1234567890ab"
default_user_ad_tag = "1234567890abcdef1234567890abcdef"
default_max_tcp_conns = 5
default_data_quota_bytes = 1073741824
default_max_unique_ips = 3
default_expiration = "2027-12-31T23:59:59Z"
`
	f, err := os.CreateTemp("", "config-*.toml")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(f.Name())
	f.WriteString(toml)
	f.Close()

	cfg, err := Load(f.Name())
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	if cfg.Users.DefaultSecret != "abcdef1234567890abcdef1234567890ab" {
		t.Errorf("DefaultSecret = %q, want configured value", cfg.Users.DefaultSecret)
	}
	if cfg.Users.DefaultUserAdTag != "1234567890abcdef1234567890abcdef" {
		t.Errorf("DefaultUserAdTag = %q, want configured value", cfg.Users.DefaultUserAdTag)
	}
	if cfg.Users.DefaultMaxTcpConns != 5 {
		t.Errorf("DefaultMaxTcpConns = %d, want 5", cfg.Users.DefaultMaxTcpConns)
	}
	if cfg.Users.DefaultDataQuotaBytes != 1073741824 {
		t.Errorf("DefaultDataQuotaBytes = %d, want 1073741824", cfg.Users.DefaultDataQuotaBytes)
	}
	if cfg.Users.DefaultMaxUniqueIps != 3 {
		t.Errorf("DefaultMaxUniqueIps = %d, want 3", cfg.Users.DefaultMaxUniqueIps)
	}
	if cfg.Users.DefaultExpiration != "2027-12-31T23:59:59Z" {
		t.Errorf("DefaultExpiration = %q, want configured value", cfg.Users.DefaultExpiration)
	}
}

func TestLoadInvalidExpiration(t *testing.T) {
	toml := `
listen = "0.0.0.0:8080"
[telemt]
url = "http://127.0.0.1:9091"
auth_header = "test"
[auth]
username = "admin"
password_hash = "$2a$10$abcdefghijklmnopqrstuvwxABCDEFGHIJ"
jwt_secret = "test-secret-that-is-at-least-32-characters"
[users]
default_expiration = "not-a-valid-rfc3339"
`
	f, err := os.CreateTemp("", "config-*.toml")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(f.Name())
	f.WriteString(toml)
	f.Close()

	_, err = Load(f.Name())
	if err == nil {
		t.Fatal("Expected error for invalid default_expiration, got nil")
	}
}
