package store

import (
	"errors"
	"strings"
	"testing"
)

func TestOpenMemoryAndInfo(t *testing.T) {
	opened, err := Open(OpenOptions{Driver: "memory"})
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Close()
	info := opened.Info()
	if info.Driver != "memory" || info.Durable || info.SizeHint != 0 {
		t.Fatalf("unexpected memory info: %+v", info)
	}
}

func TestOpenNormalizesMemoryDriver(t *testing.T) {
	for _, driver := range []string{"", "  MeMoRy  "} {
		opened, err := Open(OpenOptions{Driver: driver, Path: "ignored"})
		if err != nil {
			t.Fatalf("Open(%q): %v", driver, err)
		}
		if got := opened.Driver(); got != "memory" {
			t.Fatalf("Open(%q) driver = %q", driver, got)
		}
		if err := opened.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestOpenRejectsUnknownDriver(t *testing.T) {
	if _, err := Open(OpenOptions{Driver: "oracle"}); err == nil || !strings.Contains(err.Error(), "unknown driver") {
		t.Fatalf("Open unknown driver error = %v", err)
	} else {
		var unknown *UnknownDriverError
		if !errors.As(err, &unknown) || IsRuntimeOpenError(err) {
			t.Fatalf("Open unknown driver error type = %T", err)
		}
	}
}

func TestOpenErrorUnwrapsCause(t *testing.T) {
	cause := errors.New("open failed")
	err := &OpenError{Driver: "sqlite", Err: cause}
	if !errors.Is(err, cause) || !IsRuntimeOpenError(err) {
		t.Fatalf("OpenError classification = %T %v", err, err)
	}
}
