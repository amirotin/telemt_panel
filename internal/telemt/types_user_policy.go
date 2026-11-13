package telemt

import "context"

// InheritedLimit keeps configured zero distinct from the authoritative resolved value.
type InheritedLimit struct {
	Value              *uint64 `json:"value"`
	ConfiguredOverride *uint64 `json:"configured_override"`
	GlobalValue        uint64  `json:"global_value"`
	Origin             string  `json:"origin"`
}

// UserLimitSnapshot resolves user overrides against global defaults.
type UserLimitSnapshot struct {
	MaxTCPConns  InheritedLimit `json:"max_tcp_conns"`
	MaxUniqueIPs InheritedLimit `json:"max_unique_ips"`
}

// UserLimitState distinguishes desired configuration from the active snapshot.
type UserLimitState struct {
	Desired              UserLimitSnapshot  `json:"desired"`
	Effective            *UserLimitSnapshot `json:"effective"`
	EffectiveScope       string             `json:"effective_scope"`
	SubsystemConvergence string             `json:"subsystem_convergence"`
}

// SourceDenyState reports generation publication; a null effective list is unknown.
type SourceDenyState struct {
	Effective             []string `json:"effective" normalize:"nullable"`
	RuntimeReloadRequired *bool    `json:"runtime_reload_required"`
	ApplyMode             string   `json:"apply_mode"`
	ReloadEndpoint        string   `json:"reload_endpoint"`
	EffectiveScope        string   `json:"effective_scope"`
}

// UserSourceDenySupported checks authoritative metadata without hiding transient failures.
func (c *Client) UserSourceDenySupported(ctx context.Context) (bool, error) {
	discovery, err := c.Discovery(ctx)
	if err != nil {
		if optionalRouteAbsent(err) {
			return false, nil
		}
		return false, err
	}
	if discovery.SchemaVersion == 0 {
		return false, ErrInvalidResponse
	}
	schema, err := c.ConfigSchema(ctx)
	if err != nil {
		if optionalRouteAbsent(err) {
			return false, nil
		}
		return false, err
	}
	if schema.SchemaVersion == 0 || len(schema.Fields) == 0 {
		c.capsMu.Lock()
		c.schemaValid = false
		c.capsMu.Unlock()
		return false, ErrInvalidResponse
	}
	for _, field := range schema.Fields {
		if field.Path != "access.user_source_deny" || field.API.RequestField != "source_deny" {
			continue
		}
		create, patch := false, false
		for _, route := range field.API.WriteRoutes {
			create = create || route == "POST /v1/users"
			patch = patch || route == "PATCH /v1/users/{username}"
		}
		return create && patch, nil
	}
	return false, nil
}
