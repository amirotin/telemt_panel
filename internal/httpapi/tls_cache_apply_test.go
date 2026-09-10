package httpapi

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/paneltls"
)

func TestPanelAccessACMECacheApply(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	root := &x509.Certificate{SerialNumber: big.NewInt(1), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(365 * 24 * time.Hour)}
	rootDER, err := x509.CreateCertificate(rand.Reader, root, root, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	leaf := &x509.Certificate{SerialNumber: big.NewInt(2), DNSNames: []string{"panel.example.com"}, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(90 * 24 * time.Hour)}
	leafDER, err := x509.CreateCertificate(rand.Reader, leaf, root, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	rootPath := filepath.Join(dir, "root.pem")
	if err := os.WriteFile(rootPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: rootDER}), 0600); err != nil {
		t.Fatal(err)
	}
	cache := append(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER})...)
	cache = append(cache, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: rootDER})...)
	input, _ := json.Marshal(struct {
		Chain [][]byte
		Cache []byte
	}{[][]byte{leafDER, rootDER}, cache})
	executable, _ := os.Executable()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, executable, "-test.run=^TestPanelAccessACMECacheApplyHelper$")
	// System roots are initialized from this isolated process-local test file.
	// Neither production API inputs nor the panel process environment is changed.
	command.Env = append(os.Environ(), "PANEL_TEST_CACHE_APPLY=1", "SSL_CERT_FILE="+rootPath)
	command.Stdin = bytes.NewReader(input)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("cache apply subprocess: %v\n%s", err, output)
	}
}

func TestPanelAccessACMECacheApplyHelper(t *testing.T) {
	if os.Getenv("PANEL_TEST_CACHE_APPLY") != "1" {
		return
	}
	var input struct {
		Chain [][]byte
		Cache []byte
	}
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		t.Fatal(err)
	}
	for _, mutation := range []string{"remove-entry", "remove-directory", "corrupt-entry", "mismatched-key", "readonly-directory", "replacement-chain"} {
		t.Run(mutation, func(t *testing.T) {
			if mutation == "readonly-directory" && os.Geteuid() == 0 {
				t.Skip("root can write mode0500 cache directories")
			}
			s, cookie, path := accessServer(t)
			cacheDir := filepath.Join(t.TempDir(), "cache")
			if err := os.Mkdir(cacheDir, 0700); err != nil {
				t.Fatal(err)
			}
			cachePath := filepath.Join(cacheDir, "panel.example.com")
			if err := os.WriteFile(cachePath, input.Cache, 0600); err != nil {
				t.Fatal(err)
			}
			s.access.mux = paneltls.NewChallengeMux(http.NotFoundHandler())
			acquisitions := 0
			s.access.run = func(context.Context, config.TLSCandidate) ([][]byte, error) { acquisitions++; return input.Chain, nil }
			candidate := config.TLSCandidate{Listen: s.cfg.Listen, TLS: config.TLSConfig{Mode: "acme", AcmeDomain: "panel.example.com", AcmeCacheDir: cacheDir}}
			prepared := accessRequest(t, s, cookie, "POST", "/api/settings/tls/prepare", candidate)
			if prepared.Code != 200 {
				t.Fatalf("prepare: %d %s", prepared.Code, prepared.Body.String())
			}
			var receipt tlsPrepared
			_ = json.Unmarshal(prepared.Body.Bytes(), &receipt)
			before, _ := os.ReadFile(path)
			switch mutation {
			case "remove-entry":
				_ = os.Remove(cachePath)
			case "remove-directory":
				_ = os.Rename(cacheDir, cacheDir+".held")
			case "corrupt-entry":
				_ = os.WriteFile(cachePath, []byte("invalid cached PEM"), 0600)
			case "mismatched-key":
				key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
				der, _ := x509.MarshalECPrivateKey(key)
				_, chain := pem.Decode(input.Cache)
				_ = os.WriteFile(cachePath, append(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), chain...), 0600)
			case "readonly-directory":
				_ = os.Chmod(cacheDir, 0500)
				t.Cleanup(func() { _ = os.Chmod(cacheDir, 0700) })
			case "replacement-chain":
				block, chain := pem.Decode(input.Cache)
				key, err := x509.ParseECPrivateKey(block.Bytes)
				if err != nil {
					t.Fatal(err)
				}
				_, rootPEM := pem.Decode(chain)
				rootBlock, _ := pem.Decode(rootPEM)
				root, err := x509.ParseCertificate(rootBlock.Bytes)
				if err != nil {
					t.Fatal(err)
				}
				leaf, err := x509.ParseCertificate(input.Chain[0])
				if err != nil {
					t.Fatal(err)
				}
				leaf.SerialNumber = big.NewInt(3)
				der, err := x509.CreateCertificate(rand.Reader, leaf, root, &key.PublicKey, key)
				if err != nil {
					t.Fatal(err)
				}
				replacement := append(pem.EncodeToMemory(block), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})...)
				_ = os.WriteFile(cachePath, append(replacement, rootPEM...), 0600)
			}
			applied := accessRequest(t, s, cookie, "PUT", "/api/settings/tls/config", map[string]any{"receipt": receipt.Receipt, "candidate": receipt.Candidate})
			if applied.Code != 422 {
				t.Fatalf("changed ACME cache accepted: %d %s", applied.Code, applied.Body.String())
			}
			after, _ := os.ReadFile(path)
			if !bytes.Equal(before, after) {
				t.Fatal("changed cache modified config")
			}
			if acquisitions != 1 {
				t.Fatal("apply attempted another acquisition")
			}
			if mutation == "remove-directory" {
				_ = os.Rename(cacheDir+".held", cacheDir)
			}
			if mutation == "readonly-directory" {
				_ = os.Chmod(cacheDir, 0700)
			}
			_ = os.WriteFile(cachePath, input.Cache, 0600)
			applied = accessRequest(t, s, cookie, "PUT", "/api/settings/tls/config", map[string]any{"receipt": receipt.Receipt, "candidate": receipt.Candidate})
			if applied.Code != 200 {
				t.Fatalf("restored prepared cache rejected: %d %s", applied.Code, applied.Body.String())
			}
			if acquisitions != 1 {
				t.Fatal("restored cache caused reissuance")
			}
		})
	}
}
