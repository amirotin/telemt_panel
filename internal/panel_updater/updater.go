package panel_updater

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/telemt/telemt-panel/internal/github"
	"github.com/telemt/telemt-panel/internal/sysutil"
)

type Phase string

const (
	PhaseIdle        Phase = "idle"
	PhaseChecking    Phase = "checking"
	PhaseDownloading Phase = "downloading"
	PhaseVerifying   Phase = "verifying"
	PhaseReplacing   Phase = "replacing"
	PhaseRestarting  Phase = "restarting"
	PhaseDone        Phase = "done"
	PhaseError       Phase = "error"
)

type Status struct {
	Phase   Phase    `json:"phase"`
	Message string   `json:"message,omitempty"`
	Error   string   `json:"error,omitempty"`
	Log     []string `json:"log,omitempty"`
}

type CheckResult struct {
	CurrentVersion  string `json:"current_version"`
	LatestVersion   string `json:"latest_version"`
	UpdateAvailable bool   `json:"update_available"`
	ReleaseName     string `json:"release_name"`
	ReleaseURL      string `json:"release_url"`
	PublishedAt     string `json:"published_at,omitempty"`
	Changelog       string `json:"changelog,omitempty"`
}

type Updater struct {
	mu             sync.Mutex
	status         Status
	currentVersion string
	binaryPath     string
	serviceName    string
	githubRepo     string
	releaseLimits  github.ReleaseLimits
	statusFilePath string
}

const legacyStatusFileName = "telemt-panel-update-status.json"
const statusFileName = "panel-update-status.json"

func (u *Updater) saveStatusToFile(s Status) {
	data, err := json.Marshal(s)
	if err != nil {
		log.Printf("[panel_updater] failed to marshal status: %s", err)
		return
	}
	if err := os.WriteFile(u.statusFilePath, data, 0644); err != nil {
		log.Printf("[panel_updater] failed to write status file: %s", err)
	}
}

func (u *Updater) loadStatusFromFile() bool {
	paths := []string{u.statusFilePath}
	legacyPath := filepath.Join(os.TempDir(), legacyStatusFileName)
	if legacyPath != u.statusFilePath {
		paths = append(paths, legacyPath)
	}

	for _, path := range paths {
		if u.loadStatusFromPath(path) {
			return true
		}
	}
	return false
}

func (u *Updater) loadStatusFromPath(path string) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("[panel_updater] failed to read status file %s: %s", path, err)
		}
		return false
	}
	var s Status
	if err := json.Unmarshal(data, &s); err != nil {
		log.Printf("[panel_updater] failed to unmarshal status from %s: %s", path, err)
		return false
	}
	u.mu.Lock()
	u.status = s
	u.mu.Unlock()
	log.Printf("[panel_updater] loaded status from file %s: phase=%s", path, s.Phase)

	// Clean up status file after loading
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		log.Printf("[panel_updater] failed to remove status file %s: %s", path, err)
	}
	return true
}

func New(currentVersion, binaryPath, serviceName, githubRepo, dataDir string, maxNewer, maxOlder int) *Updater {
	if maxNewer <= 0 {
		maxNewer = github.DefaultMaxNewerReleases
	}
	if maxOlder <= 0 {
		maxOlder = github.DefaultMaxOlderReleases
	}

	// Initialize staging dir and variant detection
	statusFile := filepath.Join(os.TempDir(), legacyStatusFileName)
	if dataDir != "" {
		if dir, err := sysutil.EnsureStagingDir(dataDir); err == nil {
			SetStagingDir(dir)
			statusFile = filepath.Join(dataDir, statusFileName)
		} else {
			log.Printf("[panel_updater] WARNING: staging dir setup failed: %s, using system temp", err)
		}
	}
	SetBinaryPathForDetection(binaryPath)

	u := &Updater{
		status:         Status{Phase: PhaseIdle},
		currentVersion: currentVersion,
		binaryPath:     binaryPath,
		serviceName:    serviceName,
		githubRepo:     githubRepo,
		releaseLimits:  github.ReleaseLimits{MaxNewer: maxNewer, MaxOlder: maxOlder},
		statusFilePath: statusFile,
	}
	// Try to load status from previous session (in case of restart during update)
	if u.loadStatusFromFile() && u.GetStatus().Phase == PhaseDone {
		if err := RemoveBackup(stagedBackupPath(binaryPath)); err != nil {
			log.Printf("[panel_updater] failed to remove recovered backup: %s", err)
		}
	}

	// Clean up any leftover legacy backup (old-style .bak next to binary)
	CleanupLegacyBackup(binaryPath)

	return u
}

func (u *Updater) GetStatus() Status {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.status
}

const maxLogEntries = 500

func (u *Updater) appendLog(msg string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if len(u.status.Log) >= maxLogEntries {
		u.status.Log = u.status.Log[maxLogEntries/2:]
	}
	u.status.Log = append(u.status.Log, msg)
	log.Printf("[panel_updater] %s", msg)
}

func (u *Updater) setStatus(phase Phase, message string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.status.Phase = phase
	u.status.Message = message
	u.status.Error = ""
	u.status.Log = append(u.status.Log, fmt.Sprintf("[%s] %s", phase, message))
	log.Printf("[panel_updater] %s: %s", phase, message)
}

func (u *Updater) setError(err error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.status.Phase = PhaseError
	u.status.Error = err.Error()
	u.status.Log = append(u.status.Log, fmt.Sprintf("[error] %s", err))
	log.Printf("[panel_updater] error: %s", err)
}

func (u *Updater) Releases() (*github.ReleasesResult, error) {
	owner, repo := splitOwnerRepo(u.githubRepo)
	return github.FetchReleases(owner, repo, u.currentVersion, NewAssetMatcher(), u.releaseLimits)
}

func (u *Updater) Check() (*CheckResult, error) {
	result, err := u.Releases()
	if err != nil {
		return nil, err
	}

	cr := &CheckResult{
		CurrentVersion:  result.CurrentVersion,
		UpdateAvailable: false,
	}
	for _, r := range result.Releases {
		if !r.Prerelease && !r.IsDowngrade {
			cr.LatestVersion = r.Version
			cr.UpdateAvailable = true
			cr.ReleaseName = r.Name
			cr.ReleaseURL = r.HTMLURL
			cr.PublishedAt = r.PublishedAt
			cr.Changelog = r.Changelog
			break
		}
	}
	if !cr.UpdateAvailable {
		cr.LatestVersion = result.CurrentVersion
	}

	return cr, nil
}

func (u *Updater) Apply(version string) error {
	u.mu.Lock()
	if u.status.Phase != PhaseIdle && u.status.Phase != PhaseDone && u.status.Phase != PhaseError {
		u.mu.Unlock()
		return fmt.Errorf("update already in progress: %s", u.status.Phase)
	}
	u.status = Status{Phase: PhaseIdle}
	u.mu.Unlock()

	go u.applyAsync(version)
	return nil
}

func (u *Updater) applyAsync(version string) {
	u.appendLog(fmt.Sprintf("config: binary_path=%s, service=%s, repo=%s", u.binaryPath, u.serviceName, u.githubRepo))
	u.appendLog(fmt.Sprintf("arch: asset=%s, variant=%s, sudo=%v", AssetName(), Variant(), sysutil.NeedsSudo(u.binaryPath)))

	// Pre-flight: verify passwordless sudo works before downloading
	if err := sysutil.CheckSudoAccess(u.binaryPath); err != nil {
		u.setError(err)
		return
	}

	u.setStatus(PhaseChecking, "fetching release")

	owner, repoName := splitOwnerRepo(u.githubRepo)
	var release *github.ReleaseInfo
	var err error
	if version != "" {
		u.appendLog(fmt.Sprintf("Fetching release %s...", version))
		release, err = github.FetchRelease(owner, repoName, version, NewAssetMatcher())
	} else {
		u.appendLog("Fetching latest release...")
		result, fetchErr := github.FetchReleases(owner, repoName, u.currentVersion, NewAssetMatcher(), u.releaseLimits)
		if fetchErr != nil {
			err = fetchErr
		} else {
			for i := range result.Releases {
				if !result.Releases[i].Prerelease && !result.Releases[i].IsDowngrade {
					release = &result.Releases[i]
					break
				}
			}
			if release == nil {
				err = fmt.Errorf("no stable release found newer than %s", u.currentVersion)
			}
		}
	}
	if err != nil {
		u.setError(fmt.Errorf("fetch release: %w", err))
		return
	}
	u.appendLog(fmt.Sprintf("target release: %s (%s)", release.Version, release.Name))

	// Download sha256
	if release.ChecksumURL == "" {
		u.setError(fmt.Errorf("release %s has no checksum asset (*.sha256 for %s)", release.Version, AssetName()))
		return
	}
	u.setStatus(PhaseDownloading, "downloading checksum")
	u.appendLog(fmt.Sprintf("downloading sha256 from %s", release.ChecksumURL))
	shaPath, err := DownloadFile(release.ChecksumURL)
	if err != nil {
		u.setError(fmt.Errorf("download checksum: %w", err))
		return
	}
	u.appendLog(fmt.Sprintf("sha256 saved to %s", shaPath))

	shaBytes, err := os.ReadFile(shaPath)
	if err != nil {
		os.Remove(shaPath)
		u.setError(fmt.Errorf("read checksum: %w", err))
		return
	}
	u.appendLog(fmt.Sprintf("expected sha256: %s", strings.TrimSpace(string(shaBytes))))

	// Download tarball
	u.setStatus(PhaseDownloading, fmt.Sprintf("downloading %s (%d MB)", AssetName(), release.AssetSize/1024/1024))
	u.appendLog(fmt.Sprintf("downloading tarball from %s", release.AssetURL))
	tarPath, err := DownloadFile(release.AssetURL)
	if err != nil {
		os.Remove(shaPath)
		u.setError(fmt.Errorf("download tarball: %w", err))
		return
	}

	tarInfo, _ := os.Stat(tarPath)
	if tarInfo != nil {
		u.appendLog(fmt.Sprintf("tarball saved to %s (%d bytes)", tarPath, tarInfo.Size()))
	}

	// Verify sha256
	u.setStatus(PhaseVerifying, "verifying sha256 checksum")
	if err := VerifySha256(tarPath, string(shaBytes)); err != nil {
		os.Remove(tarPath)
		os.Remove(shaPath)
		u.setError(fmt.Errorf("checksum verification: %w", err))
		return
	}
	u.appendLog("sha256 checksum verified OK")

	// Backup current binary (to staging dir, always writable)
	u.setStatus(PhaseReplacing, fmt.Sprintf("backing up %s", u.binaryPath))
	backupPath, err := BackupBinary(u.binaryPath)
	if err != nil {
		os.Remove(tarPath)
		os.Remove(shaPath)
		u.setError(fmt.Errorf("backup %s: %w", u.binaryPath, err))
		return
	}
	if backupPath != "" {
		u.appendLog(fmt.Sprintf("backup created: %s", backupPath))
	} else {
		u.appendLog("no existing binary to backup")
	}

	// Extract new binary (extracts to staging, then installs with sudo if needed)
	u.setStatus(PhaseReplacing, fmt.Sprintf("extracting to %s", u.binaryPath))
	if err := ExtractBinary(tarPath, u.binaryPath); err != nil {
		os.Remove(tarPath)
		os.Remove(shaPath)
		u.setError(fmt.Errorf("extract to %s: %w", u.binaryPath, err))
		return
	}

	// Clean up downloads after extraction
	os.Remove(tarPath)
	os.Remove(shaPath)

	newInfo, _ := os.Stat(u.binaryPath)
	if newInfo != nil {
		u.appendLog(fmt.Sprintf("new binary written: %s (%d bytes, mode %s)", u.binaryPath, newInfo.Size(), newInfo.Mode()))
	}

	u.appendLog(fmt.Sprintf("updated to %s", release.Version))

	// Save final status to file BEFORE restart (so it survives the restart)
	u.mu.Lock()
	finalStatus := Status{
		Phase:   PhaseDone,
		Message: fmt.Sprintf("updated to %s", release.Version),
		Log:     u.status.Log,
	}
	u.mu.Unlock()
	u.saveStatusToFile(finalStatus)

	// Restart service (uses sudo if needed)
	u.setStatus(PhaseRestarting, fmt.Sprintf("running: systemctl restart %s", u.serviceName))
	if err := RestartService(u.serviceName); err != nil {
		u.appendLog(fmt.Sprintf("restart failed: %s, rolling back", err))
		if backupPath != "" {
			if rbErr := RestoreBackup(backupPath, u.binaryPath); rbErr != nil {
				u.setError(fmt.Errorf("restart failed (%w) AND rollback failed (%s)", err, rbErr))
				return
			}
			u.appendLog("rollback complete, restarting with old binary")
			RestartService(u.serviceName)
			RemoveBackup(backupPath)
		}
		u.setError(fmt.Errorf("restart failed, rolled back: %w", err))
		return
	}
	u.appendLog("systemctl restart succeeded")

	u.setStatus(PhaseDone, fmt.Sprintf("updated to %s", release.Version))
}
