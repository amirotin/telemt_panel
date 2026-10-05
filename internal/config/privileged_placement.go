package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func privilegeConfigPath(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		return filepath.Clean(path)
	}
	head, tail := abs, ""
	for {
		resolved, err := filepath.EvalSymlinks(head)
		if err == nil {
			return filepath.Join(resolved, tail)
		}
		if !os.IsNotExist(err) || head == string(filepath.Separator) {
			return abs
		}
		tail = filepath.Join(filepath.Base(head), tail)
		head = filepath.Dir(head)
	}
}

func privilegeConfigAliases(a, b string) bool {
	if privilegeConfigPath(a) == privilegeConfigPath(b) {
		return true
	}
	aInfo, aErr := os.Stat(a)
	bInfo, bErr := os.Stat(b)
	return aErr == nil && bErr == nil && os.SameFile(aInfo, bInfo)
}

func privilegeConfigContains(parent, child string) bool {
	parent, child = privilegeConfigPath(parent), privilegeConfigPath(child)
	if parent == string(filepath.Separator) {
		return true
	}
	if child == parent || strings.HasPrefix(child, parent+string(filepath.Separator)) {
		return true
	}
	info, err := os.Stat(parent)
	if err != nil {
		return false
	}
	for current := child; current != filepath.Dir(current); current = filepath.Dir(current) {
		currentInfo, err := os.Stat(current)
		if err == nil && os.SameFile(info, currentInfo) {
			return true
		}
	}
	return false
}

func validatePrivilegeConfigPlacement(cfg *Config, configPath string) error {
	paths := []string{cfg.Privileges.HelperPath, cfg.Privileges.PolicyPath}
	if privilegeConfigAliases(paths[0], paths[1]) {
		return fmt.Errorf("privileges helper/policy roles must be distinct; repair protected paths manually")
	}
	reserved := []string{cfg.Updates.PanelBinaryPath, cfg.Updates.PanelBinaryPath + ".bak", cfg.Updates.TelemtBinaryPath, cfg.Updates.TelemtBinaryPath + ".bak", filepath.Join(filepath.Dir(cfg.Updates.PanelBinaryPath), ".telemt-panel-panel.lock"), filepath.Join(filepath.Dir(cfg.Updates.TelemtBinaryPath), ".telemt-panel-telemt.lock")}
	if configPath != "" {
		reserved = append(reserved, configPath)
	}
	for _, authority := range paths {
		for _, path := range reserved {
			if path != "" && privilegeConfigAliases(authority, path) {
				return fmt.Errorf("privileges helper/policy path aliases a protected runtime role; repair paths manually")
			}
		}
		for _, runtime := range []string{cfg.DataDir, func() string {
			if configPath == "" {
				return ""
			}
			return filepath.Dir(configPath)
		}()} {
			if runtime == "" {
				continue
			}
			parent := filepath.Dir(authority)
			if privilegeConfigContains(runtime, parent) || privilegeConfigContains(parent, runtime) {
				return fmt.Errorf("privileges helper/policy directories must be separate from runtime config/data trees; repair paths manually")
			}
		}
	}
	return nil
}
