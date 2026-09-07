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

func TestDriverListsAreSorted(t *testing.T) {
	all := Drivers()
	available := AvailableDrivers()
	if len(all) != 2 {
		t.Fatalf("Drivers() = %v", all)
	}
	if len(available) == 0 || available[0] != "memory" {
		t.Fatalf("AvailableDrivers() = %v", available)
	}
	for _, list := range [][]string{all, available} {
		for i := 1; i < len(list); i++ {
			if list[i-1] >= list[i] {
				t.Fatalf("driver list is not sorted: %v", list)
			}
		}
	}
}
