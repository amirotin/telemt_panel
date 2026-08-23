package auth

import "golang.org/x/crypto/bcrypt"

// bcryptCost matches bcrypt.DefaultCost (10), spelled out because it is a
// value the operator's stored hash format depends on.
const bcryptCost = bcrypt.DefaultCost

// HashPassword returns the bcrypt hash of password, for use as
// cfg.Auth.PasswordHash. Used by the panel hash-password CLI subcommand.
func HashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

// VerifyPassword reports whether password matches the bcrypt hash.
func VerifyPassword(hash, password string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

// dummyPasswordHash is a fixed bcrypt hash (cost 10) with no known
// plaintext. VerifyCredentials compares against it when the username
// doesn't match, so a bcrypt comparison always runs — and always costs the
// same — regardless of whether the username is real.
const dummyPasswordHash = "$2a$10$Ph6q3hjW8AtIjY.5GquOtOrqc7qWvB.h31kXJw0nDJAWSgXRPekmq"

// VerifyCredentials reports whether username/password match the
// configured admin account (cfgUsername/cfgPasswordHash). It always runs
// exactly one bcrypt comparison — against cfgPasswordHash when the
// username matches, otherwise against a fixed dummy hash — so a wrong
// username and a wrong password take the same time. Without this, the
// short-circuiting `username == cfgUsername && VerifyPassword(...)` would
// skip bcrypt entirely on a bad username, letting an attacker distinguish
// "wrong username" from "wrong password" by response latency.
func VerifyCredentials(cfgUsername, cfgPasswordHash, username, password string) bool {
	usernameMatch := username == cfgUsername
	hash := dummyPasswordHash
	if usernameMatch {
		hash = cfgPasswordHash
	}
	passwordOK := VerifyPassword(hash, password)
	return usernameMatch && passwordOK
}
