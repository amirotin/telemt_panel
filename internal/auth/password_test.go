package auth

import "testing"

func TestHashAndVerifyPassword(t *testing.T) {
	hash, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if !VerifyPassword(hash, "correct horse battery staple") {
		t.Error("VerifyPassword: correct password rejected")
	}
	if VerifyPassword(hash, "wrong password") {
		t.Error("VerifyPassword: wrong password accepted")
	}
}

func TestVerifyPasswordRejectsMalformedHash(t *testing.T) {
	if VerifyPassword("not-a-bcrypt-hash", "anything") {
		t.Error("VerifyPassword: malformed hash accepted")
	}
}

func TestVerifyCredentials(t *testing.T) {
	hash, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}

	tests := []struct {
		name     string
		username string
		password string
		want     bool
	}{
		{"correct username and password", "admin", "correct horse battery staple", true},
		{"correct username, wrong password", "admin", "wrong", false},
		{"wrong username, correct password", "nobody", "correct horse battery staple", false},
		{"wrong username and password", "nobody", "wrong", false},
		{"empty username and password", "", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := VerifyCredentials("admin", hash, tt.username, tt.password); got != tt.want {
				t.Errorf("VerifyCredentials(%q, %q) = %v, want %v", tt.username, tt.password, got, tt.want)
			}
		})
	}
}
