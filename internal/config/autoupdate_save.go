package config

import (
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
)

// SaveAutoUpdateSettings updates the [<component>.auto_update] sections in the
// panel's own config file by editing only the affected lines. Unlike a
// parse→marshal round-trip, this preserves the operator's comments, key order
// and formatting byte-for-byte. The file is rewritten in place (same inode)
// so ownership and permissions survive.
func SaveAutoUpdateSettings(path string, sections map[string]AutoUpdateConfig) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("stat config: %w", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read config: %w", err)
	}

	lines := strings.Split(string(data), "\n")

	names := make([]string, 0, len(sections))
	for name := range sections {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		lines = upsertAutoUpdateSection(lines, name, sections[name])
	}

	out := strings.Join(lines, "\n")
	if err := os.WriteFile(path, []byte(out), info.Mode().Perm()); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	return nil
}

// upsertAutoUpdateSection replaces the three auto_update keys inside the
// component's section, adding the section or missing keys as needed.
func upsertAutoUpdateSection(lines []string, component string, au AutoUpdateConfig) []string {
	header := "[" + component + ".auto_update]"
	kv := [][2]string{
		{"enabled", strconv.FormatBool(au.Enabled)},
		{"check_interval", strconv.Quote(au.CheckInterval)},
		{"auto_apply", strconv.FormatBool(au.AutoApply)},
	}

	start := -1
	for i, l := range lines {
		if strings.ReplaceAll(strings.TrimSpace(l), " ", "") == header {
			start = i
			break
		}
	}

	if start == -1 {
		if len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) != "" {
			lines = append(lines, "")
		}
		// Drop a single trailing empty line so the section isn't preceded by two.
		if len(lines) > 1 && lines[len(lines)-1] == "" && strings.TrimSpace(lines[len(lines)-2]) == "" {
			lines = lines[:len(lines)-1]
		}
		lines = append(lines, header)
		for _, e := range kv {
			lines = append(lines, e[0]+" = "+e[1])
		}
		lines = append(lines, "")
		return lines
	}

	end := len(lines)
	for i := start + 1; i < len(lines); i++ {
		if strings.HasPrefix(strings.TrimSpace(lines[i]), "[") {
			end = i
			break
		}
	}

	seen := map[string]bool{}
	for i := start + 1; i < end; i++ {
		t := strings.TrimSpace(lines[i])
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		key, _, ok := strings.Cut(t, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		for _, e := range kv {
			if key == e[0] {
				lines[i] = e[0] + " = " + e[1]
				seen[e[0]] = true
			}
		}
	}

	var missing []string
	for _, e := range kv {
		if !seen[e[0]] {
			missing = append(missing, e[0]+" = "+e[1])
		}
	}
	if len(missing) == 0 {
		return lines
	}

	// Insert missing keys after the section's last non-blank line.
	insertAt := end
	for insertAt > start+1 && strings.TrimSpace(lines[insertAt-1]) == "" {
		insertAt--
	}
	result := make([]string, 0, len(lines)+len(missing))
	result = append(result, lines[:insertAt]...)
	result = append(result, missing...)
	result = append(result, lines[insertAt:]...)
	return result
}
