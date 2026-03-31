package panel_updater

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/telemt/telemt-panel/internal/sysutil"
)

var downloadClient = &http.Client{Timeout: 5 * time.Minute}

// stagingDir is set by the updater to control where downloads and backups go.
var stagingDir string

// SetStagingDir configures the directory used for downloads and backups.
func SetStagingDir(dir string) {
	stagingDir = dir
}

func downloadDir() string {
	if stagingDir != "" {
		return stagingDir
	}
	return os.TempDir()
}

func stagedBackupPath(binaryPath string) string {
	return filepath.Join(downloadDir(), filepath.Base(binaryPath)+".bak")
}

func DownloadFile(url string) (string, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return "", err
	}

	resp, err := downloadClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("download: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return "", fmt.Errorf("download returned status %d", resp.StatusCode)
	}

	tmp, err := os.CreateTemp(downloadDir(), "panel-update-*")
	if err != nil {
		return "", err
	}
	defer tmp.Close()

	if _, err := io.Copy(tmp, resp.Body); err != nil {
		os.Remove(tmp.Name())
		return "", err
	}

	return tmp.Name(), nil
}

func VerifySha256(path string, expectedLine string) error {
	expectedHash := strings.Fields(expectedLine)[0]

	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}

	actual := hex.EncodeToString(h.Sum(nil))
	if actual != expectedHash {
		return fmt.Errorf("sha256 mismatch: expected %s, got %s", expectedHash, actual)
	}
	return nil
}

// ExtractBinary extracts the first regular file from the tar.gz archive
// into the staging directory, then installs it to destPath (using sudo if needed).
func ExtractBinary(tarGzPath, destPath string) error {
	f, err := os.Open(tarGzPath)
	if err != nil {
		return err
	}
	defer f.Close()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return fmt.Errorf("no files found in archive")
		}
		if err != nil {
			return err
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}

		// Extract to staging dir (always writable)
		extractDir := downloadDir()
		tmp, err := os.CreateTemp(extractDir, ".panel-extract-*")
		if err != nil {
			return err
		}
		tmpName := tmp.Name()

		if _, err := io.Copy(tmp, tr); err != nil {
			tmp.Close()
			os.Remove(tmpName)
			return err
		}
		tmp.Close()

		if err := os.Chmod(tmpName, 0755); err != nil {
			os.Remove(tmpName)
			return err
		}

		// Rename to the expected basename so the path matches the sudoers rule
		// (sudoers expects e.g. staging/telemt-panel, not a random temp name)
		expectedPath := filepath.Join(extractDir, filepath.Base(destPath))
		if err := os.Rename(tmpName, expectedPath); err != nil {
			os.Remove(tmpName)
			return fmt.Errorf("rename extracted binary to %s: %w", expectedPath, err)
		}

		// Install to destination (uses sudo if we can't write to dest dir)
		if err := sysutil.InstallBinary(expectedPath, destPath); err != nil {
			os.Remove(expectedPath)
			return err
		}
		os.Remove(expectedPath)
		return nil
	}
}

// BackupBinary creates a backup of the binary in the staging directory.
func BackupBinary(binaryPath string) (string, error) {
	return sysutil.BackupBinary(binaryPath, downloadDir())
}

// RestoreBackup restores binaryPath from the given backup file.
// It renames the backup to the expected basename so the sudo command
// matches the sudoers rule (e.g. staging/telemt-panel instead of staging/telemt-panel.bak).
func RestoreBackup(backupPath, binaryPath string) error {
	expectedPath := filepath.Join(filepath.Dir(backupPath), filepath.Base(binaryPath))
	if backupPath != expectedPath {
		if err := os.Rename(backupPath, expectedPath); err != nil {
			return sysutil.RestoreBackup(backupPath, binaryPath)
		}
		backupPath = expectedPath
	}
	return sysutil.RestoreBackup(backupPath, binaryPath)
}

// RemoveBackup removes the backup file.
func RemoveBackup(backupPath string) error {
	return sysutil.RemoveFile(backupPath)
}

// RestartService restarts a systemd service, using sudo if needed.
func RestartService(serviceName string) error {
	return sysutil.RestartService(serviceName)
}

// backupPathLegacy returns the old-style backup path next to the binary.
func backupPathLegacy(binaryPath string) string {
	return binaryPath + ".bak"
}

// CleanupLegacyBackup removes old-style .bak file next to the binary.
func CleanupLegacyBackup(binaryPath string) {
	p := backupPathLegacy(binaryPath)
	if _, err := os.Stat(p); err == nil {
		if os.Remove(p) != nil {
			_ = exec.Command("sudo", "rm", "-f", p).Run()
		}
	}
}
