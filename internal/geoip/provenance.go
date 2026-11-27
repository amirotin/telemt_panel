package geoip

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"os"
)

func locationIdentity(raw string, source Source) string {
	if source == SourceFiles {
		return raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	u.User, u.RawQuery, u.Fragment, u.RawFragment = nil, "", "", ""
	u.ForceQuery = false
	return u.String()
}

func databaseSHA256(ctx context.Context, path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if err := copyWithContext(ctx, hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
