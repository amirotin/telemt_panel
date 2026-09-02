package httpapi

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

// Telemt's Config API currently accepts unknown nested keys and silently
// drops them. Build the main allow-list from the normalized config returned
// by the connected instance, then add fields that 3.5.5 legitimately omits
// when their Option/array/table is empty. This keeps the guard forward-
// compatible for fields a newer Telemt actually exposes while failing
// closed for misspellings such as timeouts.tg_connect.

type telemtConfigPathSet map[string]struct{}

func (s telemtConfigPathSet) add(path string) {
	if path == "" {
		return
	}
	parts := strings.Split(path, ".")
	for i := range parts {
		parent := strings.Join(parts[:i+1], ".")
		s[parent] = struct{}{}
		if strings.HasSuffix(parent, "[]") {
			s[strings.TrimSuffix(parent, "[]")] = struct{}{}
		}
	}
}

func collectTelemtConfigPaths(value any, path string, paths telemtConfigPathSet) {
	paths.add(path)
	switch value := value.(type) {
	case map[string]any:
		for key, child := range value {
			collectTelemtConfigPaths(child, joinConfigPath(path, key), paths)
		}
	case []any:
		itemPath := path + "[]"
		paths.add(itemPath)
		for _, child := range value {
			collectTelemtConfigPaths(child, itemPath, paths)
		}
	}
}

func joinConfigPath(parent, key string) string {
	if parent == "" {
		return key
	}
	return parent + "." + key
}

func telemtConfigPaths(snapshot telemt.ConfigSections) (telemtConfigPathSet, error) {
	paths := make(telemtConfigPathSet)
	for section, raw := range snapshot {
		var value any
		if err := json.Unmarshal(raw, &value); err != nil {
			return nil, fmt.Errorf("decode config schema section %s: %w", section, err)
		}
		collectTelemtConfigPaths(value, section, paths)
	}
	for _, path := range telemt355ConfigPaths {
		paths.add(path)
	}
	return paths, nil
}

func validateTelemtConfigPatch(sections map[string]json.RawMessage, snapshot telemt.ConfigSections) error {
	paths, err := telemtConfigPaths(snapshot)
	if err != nil {
		return err
	}
	for section, raw := range sections {
		var value any
		if err := json.Unmarshal(raw, &value); err != nil {
			return fmt.Errorf("invalid JSON in sections.%s", section)
		}
		if err := validateTelemtConfigValue(value, section, paths); err != nil {
			return err
		}
	}
	return nil
}

func validateTelemtConfigValue(value any, path string, paths telemtConfigPathSet) error {
	if path == "dc_overrides" {
		return validateDCOverrides(value)
	}
	if path == "censorship.exclusive_mask" {
		return validateStringMap(value, path)
	}
	if _, ok := paths[path]; !ok {
		return fmt.Errorf("unknown Telemt 3.5.5 config field: %s", path)
	}

	switch value := value.(type) {
	case map[string]any:
		for key, child := range value {
			if err := validateTelemtConfigValue(child, joinConfigPath(path, key), paths); err != nil {
				return err
			}
		}
	case []any:
		itemPath := path + "[]"
		for _, child := range value {
			if object, ok := child.(map[string]any); ok {
				if _, known := paths[itemPath]; !known {
					return fmt.Errorf("unknown Telemt 3.5.5 config field: %s", itemPath)
				}
				if err := validateTelemtConfigValue(object, itemPath, paths); err != nil {
					return err
				}
				continue
			}
			// Scalar arrays are represented as one catalogued field (for
			// example general.ntp_servers or upstreams[].bind_addresses).
			// Their item type is left to Telemt's own semantic validation.
		}
	}
	return nil
}

func validateStringMap(value any, path string) error {
	object, ok := value.(map[string]any)
	if !ok {
		// Telemt remains authoritative for value/type errors.
		return nil
	}
	for key, child := range object {
		if _, ok := child.(string); !ok && child != nil {
			return fmt.Errorf("%s.%s must be a string", path, key)
		}
	}
	return nil
}

func validateDCOverrides(value any) error {
	object, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	for dc, child := range object {
		addresses, ok := child.([]any)
		if !ok {
			return fmt.Errorf("dc_overrides.%s must be an array", dc)
		}
		for _, address := range addresses {
			if _, ok := address.(string); !ok {
				return fmt.Errorf("dc_overrides.%s entries must be strings", dc)
			}
		}
	}
	return nil
}
