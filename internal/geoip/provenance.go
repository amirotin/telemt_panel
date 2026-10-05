package geoip

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
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

func databaseSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
