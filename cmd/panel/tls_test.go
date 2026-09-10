package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestTLSPrepareRejectsUntrustedInputsWithoutNetwork(t *testing.T) {
	for _, input := range []string{`{}`, `{"listen":"127.0.0.1:8443","tls":{"mode":"acme","acme_domain":"127.0.0.1"}}`, `{"listen":"127.0.0.1:8443","tls":{"mode":"acme","acme_domain":"panel.example","acme_cache_dir":"/tmp/cache"},"directory_url":"http://localhost"}`, `{"listen":"127.0.0.1:8443","tls":{"mode":"http"}}`} {
		var output bytes.Buffer
		if err := runTLSPrepare(strings.NewReader(input), &output); err == nil {
			t.Fatal("invalid helper input accepted")
		}
		if output.Len() != 0 {
			t.Fatal("invalid helper input produced output")
		}
	}
}
