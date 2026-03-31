// Package sysutil provides shared system utilities for updater packages:
// filesystem permission checks, sudo-aware file operations, service management,
// staging directory management, and libc variant detection.
package sysutil

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

var fileCopier = io.Copy

// CanWrite checks if the current process can write to the given directory.
// It attempts to create and immediately remove a temp file.
func CanWrite(dir string) bool {
	f, err := os.CreateTemp(dir, ".write-check-*")
	if err != nil {
		return false
	}
	name := f.Name()
	f.Close()
	os.Remove(name)
	return true
}

// NeedsSudo returns true if the current process cannot write to the
// directory containing the given file path.
func NeedsSudo(filePath string) bool {
	return !CanWrite(filepath.Dir(filePath))
}

// EnsureStagingDir creates dataDir/staging if it doesn't exist.
// Returns the staging directory path.
func EnsureStagingDir(dataDir string) (string, error) {
	dir := filepath.Join(dataDir, "staging")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", fmt.Errorf("create staging dir %s: %w", dir, err)
	}
	return dir, nil
}

// CheckSudoAccess verifies that the current process can use passwordless sudo.
// Returns nil if sudo is not needed, or if passwordless sudo is working.
// Returns an error with actionable guidance if sudo is needed but not configured.
func CheckSudoAccess(binaryPath string) error {
	if !NeedsSudo(binaryPath) {
		return nil
	}
	// Test passwordless sudo with a harmless command
	cmd := exec.Command("sudo", "-n", "true")
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("passwordless sudo is required to replace %s but is not configured for the panel user.\n"+
			"Fix options:\n"+
			"  1. Re-run the install script to regenerate the sudoers drop-in\n"+
			"  2. Verify /etc/sudoers.d/telemt-panel exists and has paths matching config.toml\n"+
			"  3. Or change binary_path to a directory the panel user can write to\n"+
			"Diagnostic: %s",
			binaryPath, strings.TrimSpace(string(out)))
	}
	return nil
}

// InstallBinary copies src to dst, preserving mode 0755.
// Uses sudo cp if the current process cannot write to the destination directory.
func InstallBinary(src, dst string) error {
	if NeedsSudo(dst) {
		return installBinaryWithSudo(src, dst)
	}
	return installBinaryAtomic(src, dst)
}

func installBinaryAtomic(src, dst string) error {
	srcFile, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("cannot read source file %s: %w", src, err)
	}
	defer srcFile.Close()

	dstDir := filepath.Dir(dst)
	tmp, err := os.CreateTemp(dstDir, "."+filepath.Base(dst)+".tmp-*")
	if err != nil {
		return fmt.Errorf("cannot create temp file in %s: %w", dstDir, err)
	}
	tmpName := tmp.Name()
	cleanupTmp := true
	defer func() {
		if cleanupTmp {
			_ = tmp.Close()
			_ = os.Remove(tmpName)
		}
	}()

	if _, err := fileCopier(tmp, srcFile); err != nil {
		return fmt.Errorf("cannot copy %s to temp file %s: %w", src, tmpName, err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("cannot sync temp file %s: %w", tmpName, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("cannot close temp file %s: %w", tmpName, err)
	}
	if err := os.Chmod(tmpName, 0755); err != nil {
		return fmt.Errorf("cannot chmod temp file %s: %w", tmpName, err)
	}
	if err := replaceFile(tmpName, dst); err != nil {
		return err
	}
	cleanupTmp = false
	return nil
}

func installBinaryWithSudo(src, dst string) error {
	tmpDst := filepath.Join(filepath.Dir(dst), "."+filepath.Base(dst)+".tmp")

	cmd := exec.Command("sudo", "cp", "-f", src, tmpDst)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("no write access to %s and sudo copy to temp file failed: %s (%w). "+
			"Configure passwordless sudo for the panel user or change binary_path to a writable location",
			filepath.Dir(dst), strings.TrimSpace(string(out)), err)
	}
	defer exec.Command("sudo", "rm", "-f", tmpDst).Run()

	cmd = exec.Command("sudo", "chmod", "0755", tmpDst)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("sudo chmod failed for %s: %s (%w)", tmpDst, strings.TrimSpace(string(out)), err)
	}

	cmd = exec.Command("sudo", "mv", "-f", tmpDst, dst)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("sudo atomic replace failed for %s: %s (%w)", dst, strings.TrimSpace(string(out)), err)
	}
	return nil
}

func replaceFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	} else if runtime.GOOS != "windows" {
		return fmt.Errorf("cannot replace %s with %s: %w", dst, src, err)
	}

	if err := os.Remove(dst); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("cannot remove %s before replace: %w", dst, err)
	}
	if err := os.Rename(src, dst); err != nil {
		return fmt.Errorf("cannot replace %s with %s: %w", dst, src, err)
	}
	return nil
}

// BackupBinary copies binaryPath to stagingDir/<basename>.bak.
// Returns the backup path. If the binary doesn't exist, returns ("", nil).
func BackupBinary(binaryPath, stagingDir string) (string, error) {
	if _, err := os.Stat(binaryPath); os.IsNotExist(err) {
		return "", nil
	}

	backupDst := filepath.Join(stagingDir, filepath.Base(binaryPath)+".bak")

	if NeedsSudo(binaryPath) {
		cmd := exec.Command("sudo", "cp", "-f", binaryPath, backupDst)
		if out, err := cmd.CombinedOutput(); err != nil {
			return "", fmt.Errorf("cannot backup %s: no read access and sudo failed: %s (%w). "+
				"Check that the panel user has read access to the binary or configure sudo",
				binaryPath, strings.TrimSpace(string(out)), err)
		}
	} else {
		data, err := os.ReadFile(binaryPath)
		if err != nil {
			return "", fmt.Errorf("cannot read binary %s for backup: %w", binaryPath, err)
		}
		if err := os.WriteFile(backupDst, data, 0755); err != nil {
			return "", fmt.Errorf("cannot write backup to %s: %w. Check that data_dir is writable", backupDst, err)
		}
	}
	return backupDst, nil
}

// RestoreBackup copies backupPath back to binaryPath using sudo if needed.
func RestoreBackup(backupPath, binaryPath string) error {
	return InstallBinary(backupPath, binaryPath)
}

// RemoveFile removes a file, ignoring "not exist" errors.
func RemoveFile(path string) error {
	err := os.Remove(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// RestartService runs "systemctl restart <name>", using sudo if direct call fails.
func RestartService(serviceName string) error {
	if !isValidServiceName(serviceName) {
		return fmt.Errorf("invalid service name: %q", serviceName)
	}

	// Try without sudo first (works if panel has polkit rule or runs as root)
	cmd := exec.Command("systemctl", "restart", serviceName)
	if _, err := cmd.CombinedOutput(); err == nil {
		return nil
	}

	// Fall back to sudo
	cmd = exec.Command("sudo", "systemctl", "restart", serviceName)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl restart %s failed: %s: %w", serviceName, string(output), err)
	}
	return nil
}

func isValidServiceName(name string) bool {
	if name == "" || len(name) > 256 {
		return false
	}
	for _, c := range name {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.') {
			return false
		}
	}
	return true
}

// DetectVariant determines whether the system should use "musl" or "gnu" binaries.
// Detection order:
//  1. Check existing binary with ldd — if "musl" appears, return "musl"
//  2. Check if /lib/ld-musl-* exists — common on Alpine/musl systems
//  3. Check glibc version via ldd --version — if >= 2.32, return "gnu"
//  4. Default to "musl" (safer: musl binaries work on both, gnu needs glibc 2.32+)
func DetectVariant(binaryPath string) string {
	// 1. Check existing binary
	if binaryPath != "" {
		if out, err := exec.Command("ldd", binaryPath).CombinedOutput(); err == nil {
			if strings.Contains(string(out), "musl") {
				return "musl"
			}
			// Has glibc linkage — but still need to check version
		}
	}

	// 2. Check for musl ld
	matches, _ := filepath.Glob("/lib/ld-musl-*")
	if len(matches) > 0 {
		return "musl"
	}

	// 3. Check glibc version
	if out, err := exec.Command("ldd", "--version").CombinedOutput(); err == nil {
		output := string(out)
		// ldd --version output: "ldd (Ubuntu GLIBC 2.35-0ubuntu3.8) 2.35"
		// or: "ldd (GNU libc) 2.31"
		// Look for version number pattern
		for _, line := range strings.Split(output, "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			// Extract version from first line (e.g. "2.35" at the end)
			fields := strings.Fields(line)
			if len(fields) > 0 {
				ver := fields[len(fields)-1]
				if isGlibcVersionSufficient(ver) {
					return "gnu"
				}
			}
			break // only check first line
		}
	}

	// 4. Default to musl (safer)
	return "musl"
}

// isGlibcVersionSufficient checks if a version string like "2.35" is >= 2.32.
func isGlibcVersionSufficient(ver string) bool {
	parts := strings.SplitN(ver, ".", 2)
	if len(parts) != 2 {
		return false
	}
	major := 0
	minor := 0
	if _, err := fmt.Sscanf(parts[0], "%d", &major); err != nil {
		return false
	}
	if _, err := fmt.Sscanf(parts[1], "%d", &minor); err != nil {
		return false
	}
	if major > 2 {
		return true
	}
	return major == 2 && minor >= 32
}
