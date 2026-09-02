package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"sort"
	"strings"

	"github.com/BurntSushi/toml"
	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

const telemtTOMLProjectionNote = "Нормализованное представление API, не исходный telemt.toml; комментарии и расположение include не сохраняются."

type telemtConfigTOMLView struct {
	Revision       string   `json:"revision"`
	TOMLProjection string   `json:"toml_projection"`
	SourceSections []string `json:"source_sections"`
	Note           string   `json:"note"`
}

type telemtConfigTOMLRequest struct {
	TOMLProjection string `json:"toml_projection"`
}

type telemtConfigTOMLPreview struct {
	Revision             string                `json:"revision"`
	Patch                telemt.ConfigSections `json:"patch"`
	PatchJSON            string                `json:"patch_json"`
	ChangedPaths         []string              `json:"changed_paths"`
	MaterializedSections []string              `json:"materialized_sections"`
	ArrayReplacements    []string              `json:"array_replacements"`
}

func (s *Server) handleGetTelemtConfigTOML(w http.ResponseWriter, r *http.Request) {
	if !s.requireConfigAPI(w, r) {
		return
	}

	ctx, cancel := contextWithTelemtConfigTimeout(r)
	defer cancel()
	sections, revision, err := s.tc.GetConfig(ctx)
	if err != nil {
		writeTelemtConfigError(w, err)
		return
	}
	projection, err := encodeTelemtConfigTOML(sections)
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "toml_projection_failed", err.Error())
		return
	}
	names := make([]string, 0, len(sections))
	for name := range sections {
		names = append(names, name)
	}
	sort.Strings(names)
	writeJSON(w, http.StatusOK, telemtConfigTOMLView{
		Revision:       revision,
		TOMLProjection: projection,
		SourceSections: names,
		Note:           telemtTOMLProjectionNote,
	})
}

func (s *Server) handlePreviewTelemtConfigTOML(w http.ResponseWriter, r *http.Request) {
	if !s.requireConfigAPI(w, r) {
		return
	}
	revision := r.Header.Get("If-Match")
	if revision == "" {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "If-Match header is required")
		return
	}
	req, ok := decodeTelemtConfigTOMLRequest(w, r)
	if !ok {
		return
	}

	ctx, cancel := contextWithTelemtConfigTimeout(r)
	defer cancel()
	preview, _, err := s.buildTelemtConfigTOMLPreview(ctx, revision, req.TOMLProjection)
	if err != nil {
		writeTelemtConfigTOMLError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, preview)
}

func (s *Server) handlePatchTelemtConfigTOML(w http.ResponseWriter, r *http.Request) {
	if !s.requireConfigAPI(w, r) {
		return
	}
	revision := r.Header.Get("If-Match")
	if revision == "" {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "If-Match header is required")
		return
	}
	reload, err := parseTelemtReloadQuery(r.URL.Query())
	if err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	req, ok := decodeTelemtConfigTOMLRequest(w, r)
	if !ok {
		return
	}

	ctx, cancel := contextWithTelemtConfigTimeout(r)
	defer cancel()
	preview, patch, err := s.buildTelemtConfigTOMLPreview(ctx, revision, req.TOMLProjection)
	if err != nil {
		writeTelemtConfigTOMLError(w, err)
		return
	}
	if len(patch) == 0 {
		auth.WriteError(w, http.StatusBadRequest, "no_changes", "TOML projection has no changes")
		return
	}
	result, status, _, err := s.tc.PatchConfig(ctx, patch, revision, reload)
	if err != nil {
		writeTelemtConfigError(w, err)
		return
	}
	s.appendAudit(r, "config.patch.toml", "", strings.Join(preview.ChangedPaths, ","))
	writeJSON(w, status, result)
}

func contextWithTelemtConfigTimeout(r *http.Request) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), telemtConfigRequestTimeout)
}

func decodeTelemtConfigTOMLRequest(w http.ResponseWriter, r *http.Request) (telemtConfigTOMLRequest, bool) {
	var req telemtConfigTOMLRequest
	decoder := json.NewDecoder(io.LimitReader(r.Body, maxTelemtConfigPatchBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "invalid request body")
		return req, false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "request body must contain exactly one JSON object")
		return req, false
	}
	if strings.TrimSpace(req.TOMLProjection) == "" {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "toml_projection must not be empty")
		return req, false
	}
	return req, true
}

type telemtConfigTOMLError struct {
	code    string
	message string
}

func (e *telemtConfigTOMLError) Error() string { return e.message }

func writeTelemtConfigTOMLError(w http.ResponseWriter, err error) {
	var tomlErr *telemtConfigTOMLError
	if errors.As(err, &tomlErr) {
		status := http.StatusBadRequest
		if tomlErr.code == "revision_conflict" {
			status = http.StatusConflict
		}
		auth.WriteError(w, status, tomlErr.code, tomlErr.message)
		return
	}
	writeTelemtConfigError(w, err)
}

func (s *Server) buildTelemtConfigTOMLPreview(ctx context.Context, expectedRevision, projection string) (telemtConfigTOMLPreview, map[string]any, error) {
	currentRaw, currentRevision, err := s.tc.GetConfig(ctx)
	if err != nil {
		return telemtConfigTOMLPreview{}, nil, err
	}
	if currentRevision != expectedRevision {
		return telemtConfigTOMLPreview{}, nil, &telemtConfigTOMLError{code: "revision_conflict", message: "configuration changed since the TOML projection was loaded"}
	}
	current, err := decodeTelemtConfigSections(currentRaw)
	if err != nil {
		return telemtConfigTOMLPreview{}, nil, err
	}
	desired := make(map[string]any)
	if _, err := toml.Decode(projection, &desired); err != nil {
		return telemtConfigTOMLPreview{}, nil, &telemtConfigTOMLError{code: "invalid_toml", message: err.Error()}
	}
	desiredRaw, err := encodeTelemtConfigSections(desired)
	if err != nil {
		return telemtConfigTOMLPreview{}, nil, err
	}
	if err := validateTelemtConfigPatch(desiredRaw, currentRaw); err != nil {
		return telemtConfigTOMLPreview{}, nil, &telemtConfigTOMLError{code: "invalid_config_path", message: err.Error()}
	}
	// BurntSushi/toml represents arrays of tables as []map[string]any,
	// while the JSON-backed Telemt snapshot uses []any. Canonicalize the
	// decoded projection through the lossless JSON-section path before
	// comparing it; otherwise an unchanged array would look different and
	// a newly added array would not be classified as a wholesale replace.
	desired, err = decodeTelemtConfigSections(desiredRaw)
	if err != nil {
		return telemtConfigTOMLPreview{}, nil, err
	}

	patchValue, changedPaths, materialized, arrays, missing := diffTelemtConfig(current, desired)
	if len(missing) > 0 {
		sort.Strings(missing)
		return telemtConfigTOMLPreview{}, nil, &telemtConfigTOMLError{
			code:    "config_unset_unsupported",
			message: "Config API cannot remove keys; restore these paths or edit the source file: " + strings.Join(missing, ", "),
		}
	}
	patch, _ := patchValue.(map[string]any)
	patchRaw, err := encodeTelemtConfigSections(patch)
	if err != nil {
		return telemtConfigTOMLPreview{}, nil, err
	}
	sort.Strings(changedPaths)
	sort.Strings(materialized)
	sort.Strings(arrays)
	patchJSON, err := json.Marshal(patchRaw)
	if err != nil {
		return telemtConfigTOMLPreview{}, nil, fmt.Errorf("encode config patch preview: %w", err)
	}
	return telemtConfigTOMLPreview{
		Revision:             currentRevision,
		Patch:                patchRaw,
		PatchJSON:            string(patchJSON),
		ChangedPaths:         changedPaths,
		MaterializedSections: materialized,
		ArrayReplacements:    arrays,
	}, patch, nil
}

func encodeTelemtConfigTOML(sections telemt.ConfigSections) (string, error) {
	value, err := decodeTelemtConfigSections(sections)
	if err != nil {
		return "", err
	}
	var out bytes.Buffer
	if err := toml.NewEncoder(&out).Encode(value); err != nil {
		return "", fmt.Errorf("encode TOML projection: %w", err)
	}
	return out.String(), nil
}

func decodeTelemtConfigSections(sections telemt.ConfigSections) (map[string]any, error) {
	result := make(map[string]any, len(sections))
	for name, raw := range sections {
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		var value any
		if err := decoder.Decode(&value); err != nil {
			return nil, fmt.Errorf("decode config section %s: %w", name, err)
		}
		normalized, err := normalizeJSONNumbers(value)
		if err != nil {
			return nil, fmt.Errorf("decode config section %s: %w", name, err)
		}
		result[name] = normalized
	}
	return result, nil
}

func normalizeJSONNumbers(value any) (any, error) {
	switch value := value.(type) {
	case json.Number:
		if integer, err := value.Int64(); err == nil {
			return integer, nil
		}
		decimal, err := value.Float64()
		if err != nil {
			return nil, fmt.Errorf("number %q is outside TOML's supported range", value)
		}
		return decimal, nil
	case map[string]any:
		for key, child := range value {
			normalized, err := normalizeJSONNumbers(child)
			if err != nil {
				return nil, err
			}
			value[key] = normalized
		}
	case []any:
		for index, child := range value {
			normalized, err := normalizeJSONNumbers(child)
			if err != nil {
				return nil, err
			}
			value[index] = normalized
		}
	}
	return value, nil
}

func encodeTelemtConfigSections(sections map[string]any) (telemt.ConfigSections, error) {
	result := make(telemt.ConfigSections, len(sections))
	for name, value := range sections {
		raw, err := json.Marshal(value)
		if err != nil {
			return nil, fmt.Errorf("encode config section %s: %w", name, err)
		}
		result[name] = raw
	}
	return result, nil
}

func diffTelemtConfig(current, desired map[string]any) (any, []string, []string, []string, []string) {
	changed := make([]string, 0)
	materialized := make([]string, 0)
	arrays := make([]string, 0)
	missing := make([]string, 0)
	patch, hasChange := diffTelemtConfigValue(current, desired, "", &changed, &materialized, &arrays, &missing)
	if !hasChange {
		return map[string]any{}, changed, materialized, arrays, missing
	}
	return patch, changed, materialized, arrays, missing
}

func diffTelemtConfigValue(current, desired any, path string, changed, materialized, arrays, missing *[]string) (any, bool) {
	desiredMap, desiredIsMap := desired.(map[string]any)
	currentMap, currentIsMap := current.(map[string]any)
	if desiredIsMap && currentIsMap {
		patch := make(map[string]any)
		for key := range currentMap {
			if _, ok := desiredMap[key]; !ok {
				*missing = append(*missing, joinConfigPath(path, key))
			}
		}
		for key, desiredChild := range desiredMap {
			childPath := joinConfigPath(path, key)
			currentChild, exists := currentMap[key]
			if !exists {
				patch[key] = desiredChild
				*changed = appendLeafPaths(*changed, desiredChild, childPath)
				if path == "" {
					*materialized = append(*materialized, key)
				}
				if _, ok := desiredChild.([]any); ok {
					*arrays = append(*arrays, childPath)
				}
				continue
			}
			childPatch, childChanged := diffTelemtConfigValue(currentChild, desiredChild, childPath, changed, materialized, arrays, missing)
			if childChanged {
				patch[key] = childPatch
			}
		}
		return patch, len(patch) > 0
	}
	if _, ok := desired.([]any); ok {
		if reflect.DeepEqual(current, desired) {
			return nil, false
		}
		*changed = append(*changed, path)
		*arrays = append(*arrays, path)
		return desired, true
	}
	if reflect.DeepEqual(current, desired) {
		return nil, false
	}
	*changed = append(*changed, path)
	return desired, true
}

func appendLeafPaths(paths []string, value any, path string) []string {
	switch value := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(value))
		for key := range value {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			paths = appendLeafPaths(paths, value[key], joinConfigPath(path, key))
		}
	case []any:
		paths = append(paths, path)
	default:
		paths = append(paths, path)
	}
	return paths
}
