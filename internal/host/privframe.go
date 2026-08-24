package host

import (
	"encoding/binary"
	"fmt"
	"io"
)

// MaxFrameBytes bounds a single length-prefixed frame (an Op request or
// an AgentResponse reply) the panel-agent protocol will read or write.
// Comfortably larger than any real payload (a config file's content
// included) but small enough that a garbled or hostile declared length
// can't be used to force a huge allocation.
const MaxFrameBytes = 4 << 20 // 4 MiB

// AgentResponse is a panel-agent reply frame: `{"ok":true,"stdout":...}`
// on success, `{"ok":false,"error":...}` on failure. It mirrors ExecOp's
// (Output, error) result across the wire.
type AgentResponse struct {
	OK     bool   `json:"ok"`
	Stdout string `json:"stdout,omitempty"`
	Error  string `json:"error,omitempty"`
}

// WriteFrame writes payload to w as a 4-byte big-endian length prefix
// followed by payload itself. Used by both agent_client.go (writing an
// Op request) and cmd/panel-agent (writing an AgentResponse reply) — the
// two directions share one framing.
func WriteFrame(w io.Writer, payload []byte) error {
	if len(payload) > MaxFrameBytes {
		return fmt.Errorf("host: frame of %d bytes exceeds the %d byte limit", len(payload), MaxFrameBytes)
	}
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(payload)))
	if _, err := w.Write(hdr[:]); err != nil {
		return fmt.Errorf("host: write frame header: %w", err)
	}
	if _, err := w.Write(payload); err != nil {
		return fmt.Errorf("host: write frame payload: %w", err)
	}
	return nil
}

// ReadFrame reads one length-prefixed frame from r. A declared length
// over MaxFrameBytes is rejected before any allocation or read of the
// body, so a malformed or hostile 4-byte prefix can't be used to force a
// huge allocation or to block indefinitely reading a body that will never
// arrive in full.
func ReadFrame(r io.Reader) ([]byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, fmt.Errorf("host: read frame header: %w", err)
	}
	n := binary.BigEndian.Uint32(hdr[:])
	if n > MaxFrameBytes {
		return nil, fmt.Errorf("host: frame declares %d bytes, over the %d byte limit", n, MaxFrameBytes)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, fmt.Errorf("host: read frame payload: %w", err)
	}
	return buf, nil
}
