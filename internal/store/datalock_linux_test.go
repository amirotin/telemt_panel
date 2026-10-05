package store

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestDataDirLockProcess(t *testing.T) {
	path := os.Getenv("PANEL_DATA_LOCK_TEST_DIR")
	if path == "" {
		return
	}
	lock, err := AcquireDataDirLock(path)
	if err != nil {
		if errors.Is(err, ErrDataDirInUse) {
			fmt.Println("busy")
			os.Exit(3)
		}
		fmt.Println(err)
		os.Exit(2)
	}
	fmt.Println("owned")
	var line string
	fmt.Scanln(&line)
	lock.Close()
	os.Exit(0)
}

func TestDataDirLockStartupRaceHasOneOwner(t *testing.T) {
	directory := t.TempDir()
	commands := make([]*exec.Cmd, 2)
	inputs := make([]io.WriteCloser, 2)
	outputs := make([]*bufio.Scanner, 2)
	for i := range commands {
		command := exec.Command(os.Args[0], "-test.run=^TestDataDirLockProcess$")
		command.Env = append(os.Environ(), "PANEL_DATA_LOCK_TEST_DIR="+directory)
		input, err := command.StdinPipe()
		if err != nil {
			t.Fatal(err)
		}
		output, err := command.StdoutPipe()
		if err != nil {
			t.Fatal(err)
		}
		commands[i], inputs[i], outputs[i] = command, input, bufio.NewScanner(output)
		if err := command.Start(); err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		for i, command := range commands {
			inputs[i].Close()
			command.Process.Kill()
			command.Wait()
		}
	}()
	owned, busy := 0, 0
	for _, output := range outputs {
		if !output.Scan() {
			t.Fatal("startup process produced no ownership result")
		}
		switch output.Text() {
		case "owned":
			owned++
		case "busy":
			busy++
		default:
			t.Fatal(output.Text())
		}
	}
	if owned != 1 || busy != 1 {
		t.Fatalf("startup ownership winners=%d busy=%d", owned, busy)
	}
}

func TestDataDirLockCloseIsIdempotentAndPreservesInode(t *testing.T) {
	directory := t.TempDir()
	lock, err := AcquireDataDirLock(directory)
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(filepath.Join(directory, ".panel.lock"))
	if err != nil {
		t.Fatal(err)
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	next, err := AcquireDataDirLock(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	after, err := os.Stat(filepath.Join(directory, ".panel.lock"))
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(before, after) {
		t.Fatal("lock file was replaced on release")
	}
}

func TestDataDirLockRejectsSymlinkAndSpecialFile(t *testing.T) {
	for _, kind := range []string{"symlink", "fifo"} {
		t.Run(kind, func(t *testing.T) {
			directory := t.TempDir()
			path := filepath.Join(directory, ".panel.lock")
			if kind == "symlink" {
				outside := filepath.Join(t.TempDir(), "outside")
				if err := os.WriteFile(outside, []byte("unchanged"), 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, path); err != nil {
					t.Fatal(err)
				}
			} else if err := unix.Mkfifo(path, 0o600); err != nil {
				t.Fatal(err)
			}
			lock, err := AcquireDataDirLock(directory)
			if err == nil {
				lock.Close()
				t.Fatal("unsafe lock file accepted")
			}
		})
	}
}

func TestDataDirLockExcludesProcessesAndSurvivesCrash(t *testing.T) {
	directory := t.TempDir()
	command := exec.Command(os.Args[0], "-test.run=^TestDataDirLockProcess$")
	command.Env = append(os.Environ(), "PANEL_DATA_LOCK_TEST_DIR="+directory)
	input, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { input.Close(); command.Process.Kill(); command.Wait() }()
	scanner := bufio.NewScanner(output)
	if !scanner.Scan() || scanner.Text() != "owned" {
		t.Fatalf("owner output=%s", scanner.Text())
	}
	before, err := os.Stat(filepath.Join(directory, ".panel.lock"))
	if err != nil {
		t.Fatal(err)
	}
	if lock, err := AcquireDataDirLock(directory); !errors.Is(err, ErrDataDirInUse) {
		if lock != nil {
			lock.Close()
		}
		t.Fatalf("second owner error=%v", err)
	}
	if err := command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	command.Wait()
	lock, err := AcquireDataDirLock(directory)
	if err != nil {
		t.Fatal("lock not released on crash", err)
	}
	defer lock.Close()
	after, err := os.Stat(filepath.Join(directory, ".panel.lock"))
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(before, after) {
		t.Fatal("lock inode was replaced after crash")
	}
}
