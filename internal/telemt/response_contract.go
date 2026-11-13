package telemt

import (
	"bytes"
	"encoding/json"
)

// responseFields preserves presence independently of a field's legitimate zero.
// Unknown fields are accepted so newer Telemt versions can extend responses.
func responseFields(data []byte, required ...string) (map[string]json.RawMessage, error) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil || fields == nil {
		return nil, ErrInvalidResponse
	}
	for _, key := range required {
		if len(fields[key]) == 0 || bytes.Equal(bytes.TrimSpace(fields[key]), []byte("null")) {
			return nil, ErrInvalidResponse
		}
	}
	return fields, nil
}

// validateDecodedResponse applies only to confirmation-bearing mutations and
// new optional contracts. Established typed GET null/empty forms stay tolerant.
func validateDecodedResponse(data []byte, value any, revision string, mutation bool) error {
	switch v := value.(type) {
	case *userSecret:
		if mutation && (v.User.Username == "" || v.Secret == "") {
			return ErrInvalidResponse
		}
	case *UserInfo:
		if mutation && v.Username == "" {
			return ErrInvalidResponse
		}
	case *QuotaEntry:
		if mutation {
			_, err := responseFields(data, "used_bytes", "last_reset_epoch_secs")
			return err
		}
	case *ReloadAccepted:
		if mutation && (v.ReloadID == 0 || v.ConfigRevision == "" || v.State == "") {
			return ErrInvalidResponse
		}
	case *PatchConfigResult:
		if mutation && v.Revision == "" {
			return ErrInvalidResponse
		}
		if v.Reload != nil && (v.Reload.ReloadID == 0 || v.Reload.ConfigRevision == "" || v.Reload.State == "") {
			return ErrInvalidResponse
		}
	case *AccessPolicyState:
		return validatePolicyResponse(data, *v, revision)
	case *DiscoveryData:
		fields, err := responseFields(data, "api_version", "schema_version", "software_version", "config_schema", "read_only", "availability_scope", "operations")
		if err != nil || v.SchemaVersion == 0 || v.APIVersion == "" || v.SoftwareVersion == "" || v.ConfigSchema == "" || v.AvailabilityScope == "" || v.Operations == nil {
			return ErrInvalidResponse
		}
		var operations []json.RawMessage
		if json.Unmarshal(fields["operations"], &operations) != nil {
			return ErrInvalidResponse
		}
		for i, operation := range operations {
			if _, err := responseFields(operation, "method", "path", "supported", "enabled"); err != nil || v.Operations[i].Method == "" || v.Operations[i].Path == "" {
				return ErrInvalidResponse
			}
		}
	case *ConfigSchemaData:
		fields, err := responseFields(data, "schema_version", "value_schema_dialect", "defaults_scope", "validation_scope", "path_notation", "config_patch", "fields")
		if err != nil || v.SchemaVersion == 0 || v.ValueSchemaDialect == "" || v.DefaultsScope == "" || v.ValidationScope == "" || v.PathNotation == "" || v.Fields == nil {
			return ErrInvalidResponse
		}
		if _, err := responseFields(fields["config_patch"], "objects", "arrays", "object_null_members", "reset", "source_ownership", "if_match"); err != nil {
			return err
		}
		var entries []json.RawMessage
		if json.Unmarshal(fields["fields"], &entries) != nil {
			return ErrInvalidResponse
		}
		for i, entry := range entries {
			f, err := responseFields(entry, "path", "sensitivity", "api")
			if err != nil || v.Fields[i].Path == "" || v.Fields[i].Sensitivity == "" {
				return ErrInvalidResponse
			}
			if _, err = responseFields(f["api"], "config_read", "config_write", "read_routes", "write_routes", "null_behavior"); err != nil {
				return err
			}
		}
	}
	return nil
}

func validatePolicyResponse(data []byte, policy AccessPolicyState, revision string) error {
	fields, err := responseFields(data, "desired", "effective", "runtime", "published_match", "effective_scope", "subsystem_convergence", "apply_mode")
	if err != nil || revision == "" || policy.EffectiveScope == "" || policy.SubsystemConvergence == "" || policy.ApplyMode == "" || policy.Runtime.RuntimeMatch == "" {
		return ErrInvalidResponse
	}
	if _, err = responseFields(fields["runtime"], "active_generation", "config_epoch", "runtime_match"); err != nil {
		return err
	}
	for _, name := range []string{"desired", "effective"} {
		p, err := responseFields(fields[name], "user_max_tcp_conns_global_each", "user_max_unique_ips_global_each", "user_max_unique_ips_mode", "user_max_unique_ips_window_secs", "cidr_rate_limits")
		if err != nil {
			return err
		}
		var decoded AccessPolicy
		if json.Unmarshal(fields[name], &decoded) != nil || decoded.UserMaxUniqueIPsMode == "" || decoded.CIDRRateLimits == nil {
			return ErrInvalidResponse
		}
		var rates map[string]json.RawMessage
		if json.Unmarshal(p["cidr_rate_limits"], &rates) != nil {
			return ErrInvalidResponse
		}
		for _, rate := range rates {
			if _, err = responseFields(rate, "up_bps", "down_bps"); err != nil {
				return err
			}
		}
	}
	return nil
}
