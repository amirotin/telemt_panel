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
