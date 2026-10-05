package main

import (
	"bytes"
	"testing"
)

func TestPrivilegedCommandRejectsUnboundedArgumentShapes(t *testing.T) {
	for _, args := range [][]string{nil, {"install", "panel"}, {"--policy", "/etc/policy", "inspect", "panel"}, {"--policy", "/etc/policy", "install", "other"}, {"--policy", "/etc/policy", "remove", "panel"}, {"--policy", "/etc/policy", "install", "panel", "/arbitrary/source"}, {"--policy", "/etc/policy", "backup", "telemt", "--dest", "/arbitrary"}} {
		var output bytes.Buffer
		if err := runPrivilegedCommand(args, &output); err == nil || output.Len() != 0 {
			t.Fatalf("arguments=%v error=%v output=%s", args, err, output.String())
		}
	}
}
