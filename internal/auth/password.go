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
