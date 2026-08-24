package host

import (
	"bytes"
	"encoding/binary"
	"strings"
	"testing"
)

func TestWriteReadFrame_RoundTrip(t *testing.T) {
	cases := []struct {
		name    string
		payload []byte
	}{
		{"empty", []byte{}},
		{"small", []byte(`{"kind":"restart-service","args":{"service":"telemt"}}`)},
		{"binary-ish bytes", []byte{0, 1, 2, 255, 254, 0}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var buf bytes.Buffer
			if err := WriteFrame(&buf, tc.payload); err != nil {
				t.Fatalf("WriteFrame: %v", err)
			}
			got, err := ReadFrame(&buf)
			if err != nil {
				t.Fatalf("ReadFrame: %v", err)
			}
			if !bytes.Equal(got, tc.payload) {
				t.Errorf("got %q, want %q", got, tc.payload)
			}
			if buf.Len() != 0 {
				t.Errorf("%d trailing bytes left unread", buf.Len())
			}
		})
	}
}

func TestWriteReadFrame_MultipleFramesOnOneStream(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteFrame(&buf, []byte("first")); err != nil {
		t.Fatal(err)
	}
	if err := WriteFrame(&buf, []byte("second")); err != nil {
		t.Fatal(err)
	}
	first, err := ReadFrame(&buf)
	if err != nil || string(first) != "first" {
		t.Fatalf("first frame = %q, %v", first, err)
	}
	second, err := ReadFrame(&buf)
	if err != nil || string(second) != "second" {
		t.Fatalf("second frame = %q, %v", second, err)
	}
}

func TestWriteFrame_RejectsOversizedPayload(t *testing.T) {
	var buf bytes.Buffer
	oversized := make([]byte, MaxFrameBytes+1)
	if err := WriteFrame(&buf, oversized); err == nil {
		t.Fatal("want error for oversized payload, got nil")
	}
	if buf.Len() != 0 {
		t.Errorf("WriteFrame must not write anything on rejection, wrote %d bytes", buf.Len())
	}
}

func TestReadFrame_RejectsOversizedDeclaredLength(t *testing.T) {
	var buf bytes.Buffer
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], MaxFrameBytes+1)
	buf.Write(hdr[:])
	// Deliberately no body: ReadFrame must reject before trying to read
	// MaxFrameBytes+1 bytes that were never sent.
	if _, err := ReadFrame(&buf); err == nil {
		t.Fatal("want error for oversized declared length, got nil")
	} else if !strings.Contains(err.Error(), "exceeds") && !strings.Contains(err.Error(), "limit") {
		t.Errorf("error %q doesn't mention the size limit", err)
	}
}

func TestReadFrame_MalformedShortHeader(t *testing.T) {
	buf := bytes.NewBuffer([]byte{0, 1}) // only 2 of the required 4 header bytes
	if _, err := ReadFrame(buf); err == nil {
		t.Fatal("want error for a truncated header, got nil")
	}
}

func TestReadFrame_TruncatedBody(t *testing.T) {
	var buf bytes.Buffer
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], 10)
	buf.Write(hdr[:])
	buf.WriteString("short") // declares 10 bytes, only 5 follow
	if _, err := ReadFrame(&buf); err == nil {
		t.Fatal("want error for a truncated body, got nil")
	}
}
