package geoip

import (
	"bytes"
	"errors"
	"testing"

	"golang.org/x/sys/unix"
)

func TestStagingWriterKeepsReserveOnUnknownLength(t *testing.T) {
	var out bytes.Buffer
	free := int64(100)
	writer := &stagingWriter{out: &out, available: func() (int64, error) { return free, nil }, reserve: 10}
	if _, err := writer.Write(make([]byte, 90)); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write([]byte{1}); !errors.Is(err, unix.ENOSPC) {
		t.Fatalf("overflow: %v", err)
	}
	free = 9
	writer.untilCheck = 0
	if _, err := writer.Write([]byte{1}); !errors.Is(err, unix.ENOSPC) || out.Len() != 90 {
		t.Fatalf("concurrent disk usage: len=%d err=%v", out.Len(), err)
	}
}
