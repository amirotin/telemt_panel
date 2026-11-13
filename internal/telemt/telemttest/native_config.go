package telemttest

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

func (s *Server) nativeRuntime() telemt.RuntimeBaseline {
	return telemt.RuntimeBaseline{ActiveGeneration: 1 + s.nextReloadID, ConfigEpoch: uint64(s.revisionSeq + 1), RuntimeMatch: fmt.Sprintf("native-%d-%d", s.nextReloadID, s.revisionSeq)}
}

func (s *Server) nativeSections() telemt.ConfigSections {
	if s.nativeConfig != nil {
		return s.nativeConfig
	}
	sections := sampleConfigSections()
	sections["network"] = json.RawMessage(`{"dns_overrides":[]}`)
	sections["server"] = json.RawMessage(`{"api":{"minimal_runtime_enabled":true,"minimal_runtime_cache_ttl_ms":1000,"runtime_edge_enabled":false,"runtime_edge_cache_ttl_ms":1000,"runtime_edge_top_n":10}}`)
	sections["access"] = json.RawMessage(`{"user_source_deny":{"alice":["198.51.100.0/24"]}}`)
	var web map[string]any
	_ = json.Unmarshal(sections["web"], &web)
	web["retry_jitter"] = map[string]any{"enabled": false, "min_ms": 0, "max_ms": 250, "distribution": "uniform"}
	sections["web"], _ = json.Marshal(web)
	s.nativeEffective = telemt.ConfigSections{}
	for key, value := range sections {
		s.nativeEffective[key] = append(json.RawMessage(nil), value...)
	}
	s.nativeEffective["access"] = json.RawMessage(`{"user_source_deny":{}}`)
	s.nativeConfig = sections
	return sections
}

func nativeChangedPaths(patch map[string]any) []string {
	paths := []string{}
	var walk func(string, any)
	walk = func(prefix string, value any) {
		if object, ok := value.(map[string]any); ok {
			for key, child := range object {
				path := key
				if prefix != "" {
					path = prefix + "." + key
				}
				walk(path, child)
			}
		} else {
			paths = append(paths, prefix)
		}
	}
	walk("", patch)
	sort.Strings(paths)
	return paths
}

func nativeApply(paths []string) telemt.ConfigApplyImpact {
	apply := telemt.ConfigApplyImpact{WatcherPaths: []string{}, GenerationPaths: []string{}, ProcessRestartPaths: []string{}, DeferredProcessFields: []string{}}
	for _, path := range paths {
		if strings.HasPrefix(path, "server.api.") {
			apply.GenerationPaths = append(apply.GenerationPaths, path)
		} else {
			apply.WatcherPaths = append(apply.WatcherPaths, path)
		}
	}
	apply.RuntimeReloadRequired = len(paths) > 0
	return apply
}

func (s *Server) handleNativeConfig(w http.ResponseWriter, r *http.Request) bool {
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/v1/capabilities":
		writeOK(w, 200, telemt.DiscoveryData{APIVersion: "v1", ConfigSchema: "/v1/config/schema", AvailabilityScope: "feature_and_runtime_source_prerequisites_not_request_success", SoftwareVersion: "3.5.17", SchemaVersion: 1, ReadOnly: s.scenario.ReadOnly, Operations: []telemt.OperationCapability{
			{Method: "GET", Path: "/v1/config/schema", Supported: true, Enabled: true},
			{Method: "GET", Path: "/v1/config/state", Supported: true, Enabled: true},
			{Method: "POST", Path: "/v1/config/validate", Supported: true, Enabled: true, ReadOnlyOperation: true},
		}}, s.revision())
	case r.Method == http.MethodGet && r.URL.Path == "/v1/config/schema":
		fields := []telemt.ConfigField{}
		for _, path := range []string{"network.dns_overrides", "web.retry_jitter.enabled", "web.retry_jitter.min_ms", "web.retry_jitter.max_ms", "web.retry_jitter.distribution", "web.retry_jitter.peak_ms", "server.api.minimal_runtime_enabled", "server.api.minimal_runtime_cache_ttl_ms", "server.api.runtime_edge_enabled", "server.api.runtime_edge_cache_ttl_ms", "server.api.runtime_edge_top_n"} {
			fields = append(fields, telemt.ConfigField{Path: path, Value: json.RawMessage(`{}`), DefaultKind: "type_default", Sensitivity: "public", Apply: json.RawMessage(`{"watcher":"supported","reload":"supported","effect":"new_settings"}`), API: telemt.ConfigFieldAPI{ConfigWrite: true, ReadRoutes: []string{}, NullBehavior: "ignored", WriteRoutes: []string{"PATCH /v1/config"}}})
		}
		writeOK(w, 200, telemt.ConfigSchemaData{ValueSchemaDialect: "https://json-schema.org/draft/2020-12/schema", DefaultsScope: "unconfigured_type_defaults_before_loader_normalization", ValidationScope: "value_constraints_are_not_a_substitute_for_full_config_validation", PathNotation: "dot_members; []=array_element; {name}=dynamic_map_key", ConfigPatch: json.RawMessage(`{"objects":"recursive_merge","arrays":"replace_whole_array","object_null_members":"ignored_before_candidate_validation","reset":"not_supported","source_ownership":"one_independently_writable_source_per_mutation","if_match":"optional_source_manifest_revision"}`), SchemaVersion: 1, Fields: fields}, s.revision())
	case r.Method == http.MethodGet && r.URL.Path == "/v1/config/state":
		generation := append([]string{}, s.nativeGenerationPaths...)
		status := "published_match"
		if len(generation) > 0 {
			status = "pending_publication"
		}
		writeOK(w, 200, map[string]any{"scope": "published_configuration_not_subsystem_acknowledgment", "sections": []string{"general", "network", "server", "timeouts", "censorship", "upstreams", "dc_overrides", "web", "access", "logging", "root"}, "runtime": s.nativeRuntime(), "runtime_sample_current": true, "desired_revision": s.revision(), "desired_status": "valid", "desired": s.nativeSections(), "effective": s.nativeEffective, "comparison": map[string]any{"scope": "selected_sections", "status": status, "pending_paths": generation, "watcher_pending_paths": []string{}, "generation_pending_paths": generation, "process_deferred_paths": []string{}, "truncated": false}, "subsystem_convergence": "unknown"}, s.revision())
	case r.Method == http.MethodPost && r.URL.Path == "/v1/config/validate":
		if r.Header.Get("If-Match") != s.revision() {
			writeErr(w, 409, "revision_conflict", "source changed")
			break
		}
		if token := r.Header.Get("If-Runtime-Match"); token != "" && token != s.nativeRuntime().RuntimeMatch {
			writeErr(w, 409, "runtime_conflict", "runtime changed")
			break
		}
		var patch map[string]any
		if err := json.NewDecoder(r.Body).Decode(&patch); err != nil || len(patch) == 0 {
			writeErr(w, 400, "bad_request", "invalid patch")
			break
		}
		paths := nativeChangedPaths(patch)
		writeOK(w, 200, telemt.ConfigValidationData{Valid: true, BaseRevision: s.revision(), CandidateRevision: "native-candidate", Runtime: s.nativeRuntime(), ChangedPaths: paths, NormalizationEffects: []json.RawMessage{}, Apply: nativeApply(paths), TouchedSections: []string{}, Warnings: []telemt.FieldIssue{}}, s.revision())
	default:
		return false
	}
	return true
}

func (s *Server) mergeNativePatch(patch map[string]json.RawMessage) {
	var merge func(map[string]any, map[string]any)
	merge = func(target, source map[string]any) {
		for key, value := range source {
			child, isObject := value.(map[string]any)
			old, oldObject := target[key].(map[string]any)
			if isObject && oldObject {
				merge(old, child)
			} else {
				target[key] = value
			}
		}
	}
	sections := s.nativeSections()
	for key, raw := range patch {
		if key == "server" {
			s.nativeGenerationPaths = append(s.nativeGenerationPaths, "server.api")
		}
		var old, next map[string]any
		_ = json.Unmarshal(sections[key], &old)
		if old == nil {
			old = map[string]any{}
		}
		if json.Unmarshal(raw, &next) == nil && next != nil {
			merge(old, next)
			sections[key], _ = json.Marshal(old)
		} else {
			sections[key] = raw
		}
		if key != "server" {
			s.nativeEffective[key] = append(json.RawMessage(nil), sections[key]...)
		}
	}
}
