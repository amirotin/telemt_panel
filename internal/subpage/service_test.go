package subpage

import (
	"strings"
	"testing"
)

func TestServiceURLIncludesBasePathAndToken(t *testing.T) {
	nonces := newFakeNonces()
	svc := NewService("panel-secret", "/panel", nonces)

	url, err := svc.URL("alice", testUserSecret)
	if err != nil {
		t.Fatalf("URL: %v", err)
	}
	if !strings.HasPrefix(url, "/panel/sub/") {
		t.Fatalf("URL = %q, want a /panel/sub/ prefixed path", url)
	}

	want := "/panel/sub/" + deriveToken([]byte("panel-secret"), "alice", testUserSecret, "")
	if url != want {
		t.Fatalf("URL = %q, want %q", url, want)
	}
}

func TestServiceURLReflectsNonceRotation(t *testing.T) {
	nonces := newFakeNonces()
	svc := NewService("panel-secret", "", nonces)

	before, err := svc.URL("alice", testUserSecret)
	if err != nil {
		t.Fatalf("URL: %v", err)
	}

	if err := nonces.SetSubpageNonce("alice", "fresh-nonce"); err != nil {
		t.Fatalf("SetSubpageNonce: %v", err)
	}

	after, err := svc.URL("alice", testUserSecret)
	if err != nil {
		t.Fatalf("URL: %v", err)
	}
	if before == after {
		t.Fatal("URL did not change after rotating the nonce")
	}
}
