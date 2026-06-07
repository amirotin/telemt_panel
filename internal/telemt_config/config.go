package telemt_config

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/pelletier/go-toml/v2"
)

// ReadConfig reads Telemt config file and returns content with hash
func ReadConfig(configPath string) (content string, hash string, err error) {
	// Security: prevent path traversal
	if strings.Contains(configPath, "..") {
		return "", "", fmt.Errorf("invalid config path")
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		return "", "", fmt.Errorf("read config: %w", err)
	}

	content = string(data)
	hash = calculateHash(data)
	return content, hash, nil
}

// SaveConfig saves Telemt config with backup
func SaveConfig(configPath, content string) (newHash string, err error) {
	// Security: prevent path traversal
	if strings.Contains(configPath, "..") {
		return "", fmt.Errorf("invalid config path")
	}

	// Validate TOML syntax
	var testMap map[string]interface{}
	if err := toml.Unmarshal([]byte(content), &testMap); err != nil {
		return "", fmt.Errorf("invalid TOML syntax: %w", err)
	}

	// Strip underscores from integer literals (e.g. 8_443 → 8443)
	content = removeIntegerUnderscores(content)

	// Convert inline empty tables (e.g. `key = {}`) to proper TOML sections.
	// Telemt does not understand inline empty tables and they cause duplicate
	// key errors when Telemt rewrites the config on hot-reload.
	content = inlineTablesToSections(content)

	// Create backup
	timestamp := time.Now().Format("20060102-150405")
	backupPath := fmt.Sprintf("%s.backup.%s", configPath, timestamp)
	if err := createBackup(configPath, backupPath); err != nil {
		return "", fmt.Errorf("create backup: %w", err)
	}

	// Read original file stat to preserve ownership and permissions
	origStat, err := os.Stat(configPath)
	if err != nil && !os.IsNotExist(err) {
		return "", fmt.Errorf("stat config: %w", err)
	}

	// Atomic write: write to temp file, then rename
	dir := filepath.Dir(configPath)
	tmpFile, err := os.CreateTemp(dir, "config-*.tmp")
	if err != nil {
		return "", fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmpFile.Name()
	defer os.Remove(tmpPath) // cleanup on error

	if _, err := tmpFile.WriteString(content); err != nil {
		tmpFile.Close()
		return "", fmt.Errorf("write temp file: %w", err)
	}
	tmpFile.Close()

	// Preserve original file permissions and ownership
	if origStat != nil {
		preserveFileOwnership(tmpPath, origStat)
	}

	// Atomic rename. Falls back to direct overwrite when the destination is a
	// bind-mounted file (Docker file-mount), where rename fails with EBUSY.
	if err := os.Rename(tmpPath, configPath); err != nil {
		data, readErr := os.ReadFile(tmpPath)
		if readErr != nil {
			return "", fmt.Errorf("rename temp file: %w", err)
		}
		if writeErr := os.WriteFile(configPath, data, 0644); writeErr != nil {
			return "", fmt.Errorf("rename temp file: %w (fallback write also failed: %v)", err, writeErr)
		}
	}

	// Touch the file to trigger Telemt config hot-reload
	// (rename alone may not fire inotify MODIFY event)
	now := time.Now()
	_ = os.Chtimes(configPath, now, now)

	newHash = calculateHash([]byte(content))
	return newHash, nil
}

// QuickUpdate updates specific fields in config
func QuickUpdate(configPath string, updates map[string]interface{}) (newHash string, err error) {
	// Security: prevent path traversal
	if strings.Contains(configPath, "..") {
		return "", fmt.Errorf("invalid config path")
	}

	// Read current config
	data, err := os.ReadFile(configPath)
	if err != nil {
		return "", fmt.Errorf("read config: %w", err)
	}

	// Parse to map
	var config map[string]interface{}
	if err := toml.Unmarshal(data, &config); err != nil {
		return "", fmt.Errorf("parse config: %w", err)
	}

	// Apply updates (support nested keys via dot notation)
	for key, value := range updates {
		if value == nil {
			// Delete key
			deleteNestedKey(config, key)
		} else {
			// Set key
			setNestedKey(config, key, value)
		}
	}

	// Serialize back to TOML
	newContent, err := toml.Marshal(config)
	if err != nil {
		return "", fmt.Errorf("marshal config: %w", err)
	}

	// Remove underscores from integer literals (go-toml/v2 formats 8443 as 8_443)
	cleaned := removeIntegerUnderscores(string(newContent))

	// Save
	return SaveConfig(configPath, cleaned)
}

// Helper: set nested key like "server.port" = 443
func setNestedKey(m map[string]interface{}, key string, value interface{}) {
	parts := strings.Split(key, ".")
	current := m

	for i := 0; i < len(parts)-1; i++ {
		part := parts[i]
		if _, ok := current[part]; !ok {
			current[part] = make(map[string]interface{})
		}
		if nested, ok := current[part].(map[string]interface{}); ok {
			current = nested
		} else {
			// Can't traverse further, create new map
			newMap := make(map[string]interface{})
			current[part] = newMap
			current = newMap
		}
	}

	current[parts[len(parts)-1]] = value
}

// Helper: delete nested key
func deleteNestedKey(m map[string]interface{}, key string) {
	parts := strings.Split(key, ".")
	current := m

	for i := 0; i < len(parts)-1; i++ {
		part := parts[i]
		if nested, ok := current[part].(map[string]interface{}); ok {
			current = nested
		} else {
			return // path doesn't exist
		}
	}

	delete(current, parts[len(parts)-1])
}

var reInlineEmptyTable = regexp.MustCompile(`(?m)^(\w+)\s*=\s*\{\s*\}\s*$`)

// inlineTablesToSections converts inline empty tables like `key = {}`
// to proper TOML sections like `[parent.key]`.
// Telemt doesn't understand inline empty tables.
func inlineTablesToSections(s string) string {
	lines := strings.Split(s, "\n")
	var result []string
	currentSection := ""

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)

		// Track current section
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") && !strings.HasPrefix(trimmed, "[[") {
			currentSection = trimmed[1 : len(trimmed)-1]
			result = append(result, line)
			continue
		}

		if m := reInlineEmptyTable.FindStringSubmatch(trimmed); m != nil {
			key := m[1]
			fullSection := key
			if currentSection != "" {
				fullSection = currentSection + "." + key
			}
			result = append(result, "")
			result = append(result, "["+fullSection+"]")
			continue
		}

		result = append(result, line)
	}

	return strings.Join(result, "\n")
}

var reDigitUnderscore = regexp.MustCompile(`(\d)_(\d)`)

// removeIntegerUnderscores strips underscores from TOML integer literals
// (e.g. 8_443 → 8443). Applied repeatedly to handle 1_000_000 → 1000000.
func removeIntegerUnderscores(s string) string {
	for reDigitUnderscore.MatchString(s) {
		s = reDigitUnderscore.ReplaceAllString(s, "${1}${2}")
	}
	return s
}

func createBackup(src, dst string) error {
	srcStat, err := os.Stat(src)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // no file to backup
		}
		return err
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.WriteFile(dst, data, srcStat.Mode().Perm()); err != nil {
		return err
	}
	preserveFileOwnership(dst, srcStat)
	return nil
}

func calculateHash(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}
