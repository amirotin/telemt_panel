package httpapi

import (
	"context"

	"github.com/amirotin/telemt_panel/internal/update"
)

// The 3.5.5 inventory remains the legacy baseline. New fields are offered
// only on an identified compatible server, including absent optional tables.
// The me_bind_stale_mode default correction applies to every version,
// including the baseline inventory.
func telemtConfigCatalogForVersion(version string) telemtConfigCatalog {
	catalog := telemt355ConfigCatalog
	catalog.Fields = append([]telemtConfigField(nil), catalog.Fields...)
	for i := range catalog.Fields {
		if catalog.Fields[i].Path == "general.me_bind_stale_mode" {
			catalog.Fields[i].DefaultValue = `"never"`
		}
	}
	appendFields := func(fields ...telemtConfigField) {
		catalog.Fields = append(catalog.Fields, fields...)
		catalog.DocumentedFields += len(fields)
	}
	if update.CompareVersions(version, "3.5.6") >= 0 {
		catalog.Version = "3.5.6"
		catalog.SourceCommit = "3693d1e2a87af0074598104338b5a4bb5bee202d"
		appendFields(
			versionedConfigField("general.me_reinit_max_concurrency", "usize", "integer", "2", "me", "advanced", "runtime reload"),
			versionedConfigField("web.decoy_fasttrack_mode", "enum", "enum", "off", "web", "advanced", "process restart", "off", "shadow", "enforce"),
			versionedConfigField("web.http_connection_capacity_action", "enum", "enum", "drop", "web", "advanced", "runtime reload", "drop", "wait", "respond"),
			versionedConfigField("web.limits.max_http_overload_connections", "usize", "integer", "64", "web", "advanced", "process restart"),
			versionedConfigField("web.timeouts.bridge_recovery_secs", "u64", "integer", "15", "web", "advanced", "runtime reload"),
			versionedConfigField("web.timeouts.http_overload_timeout_ms", "u64", "integer", "250", "web", "advanced", "runtime reload"),
		)
	}
	if update.CompareVersions(version, "3.5.8") >= 0 {
		catalog.Version = "3.5.8"
		catalog.SourceCommit = "717a34771f1403ecd06c3ce0a33c955a269c389f"
		for i := range catalog.Fields {
			if catalog.Fields[i].Path == "general.direct_relay_buffer_budget_max_bytes" {
				catalog.Fields[i].Apply = "process restart"
			}
		}
		appendFields(
			versionedConfigField("web.vhosts[].base_path", "String", "string", "", "web", "normal", "runtime reload"),
			versionedConfigField("web.debug.sideband", "bool", "boolean", "false", "web", "advanced", "runtime reload"),
		)
	}
	if update.CompareVersions(version, "3.5.12") >= 0 {
		catalog.Version = "3.5.12"
		catalog.SourceCommit = "c4555e25f39dd5be200ccf6353f7d82bfcf89131"
		appendFields(versionedConfigField("web.carrier_method", "enum", "enum", "post", "web", "normal", "runtime reload", "post", "put"))
	}
	if update.CompareVersions(version, "3.5.13") >= 0 {
		catalog.Version = "3.5.13"
		catalog.SourceCommit = "d3de9865cf5d088809fdf728059bcb2b0841db67"
		appendFields(versionedConfigField("web.conveyor", "bool", "boolean", "true", "web", "normal", "runtime reload"))
	}
	if update.CompareVersions(version, "3.5.14") >= 0 {
		catalog.Version = "3.5.14"
		catalog.SourceCommit = "9d5b896bb695c55e2905b82f276da84e45a0a2ec"
		appendFields(
			versionedConfigField("web.vhosts[].decoy.resolve", "WebDecoyResolve", "enum", "never", "web", "normal", "runtime reload", "never", "startup"),
			versionedConfigField("web.timeouts.decoy_resolve_secs", "u64", "integer", "5", "web", "advanced", "runtime reload"),
		)
	}

	if update.CompareVersions(version, "3.5.16") >= 0 {
		catalog.Version = "3.5.16"
		catalog.SourceCommit = "84e5b827a6619fb2e09ad3d09f253cdffe04bc2f"
		appendFields(
			versionedConfigField("web.retry_jitter.enabled", "bool", "boolean", "false", "web", "advanced", "runtime reload"),
			versionedConfigField("web.retry_jitter.min_ms", "u32", "integer", "0", "web", "advanced", "runtime reload"),
			versionedConfigField("web.retry_jitter.max_ms", "u32", "integer", "250", "web", "advanced", "runtime reload"),
			versionedConfigField("web.retry_jitter.distribution", "enum", "enum", "uniform", "web", "advanced", "runtime reload", "uniform", "triangular"),
			versionedConfigField("web.retry_jitter.peak_ms", "Option<u32>", "integer", "null", "web", "advanced", "runtime reload"),
		)
	}
	if update.CompareVersions(version, "3.5.17") >= 0 {
		catalog.Version = "3.5.17"
		catalog.SourceCommit = "66708d2866f3f3a4541c4fa67984d408e71a8af4"
		appendFields(
			versionedConfigField("network.dns_overrides", "Vec<String>", "string_list", "[]", "routing", "advanced", "hot reload"),
			versionedConfigField("server.api.minimal_runtime_enabled", "bool", "boolean", "true", "diagnostics", "advanced", "runtime reload"),
			versionedConfigField("server.api.minimal_runtime_cache_ttl_ms", "u64", "integer", "1000", "diagnostics", "advanced", "runtime reload"),
			versionedConfigField("server.api.runtime_edge_enabled", "bool", "boolean", "false", "diagnostics", "advanced", "runtime reload"),
			versionedConfigField("server.api.runtime_edge_cache_ttl_ms", "u64", "integer", "1000", "diagnostics", "advanced", "runtime reload"),
			versionedConfigField("server.api.runtime_edge_top_n", "usize", "integer", "10", "diagnostics", "advanced", "runtime reload"),
		)
	}
	return catalog
}

func versionedConfigField(path, dataType, kind, defaultValue, group, tier, apply string, options ...string) telemtConfigField {
	return telemtConfigField{Path: path, DataType: dataType, Kind: kind, Options: options, DefaultValue: defaultValue, Group: group, Tier: tier, Apply: apply, DocHot: apply != "process restart"}
}

func (s *Server) telemtConfigVersion(ctx context.Context) string {
	if s.tc == nil {
		return ""
	}
	info, err := s.tc.SystemInfo(ctx)
	if err != nil {
		return ""
	}
	return info.Version
}
