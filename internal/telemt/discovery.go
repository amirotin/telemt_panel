package telemt

import (
	"context"
	"encoding/json"
	"net/http"
)

// FieldIssue is Telemt's structured field validation diagnostic.
type FieldIssue struct {
	Path    string `json:"path"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// OperationCapability describes support independently from current availability.
// Available is nil when the source was not sampled or its lock was busy.
type OperationCapability struct {
	ID                    string   `json:"id"`
	Method                string   `json:"method"`
	Path                  string   `json:"path"`
	Aliases               []string `json:"aliases,omitempty"`
	Gate                  string   `json:"gate"`
	Success               []int    `json:"success"`
	CredentialBearing     bool     `json:"credential_bearing"`
	Body                  string   `json:"body,omitempty"`
	OptionalBody          bool     `json:"optional_body"`
	ExactJSONContentType  bool     `json:"exact_json_content_type"`
	IfMatch               bool     `json:"if_match"`
	IfRuntimeMatch        bool     `json:"if_runtime_match"`
	ReadOnlyOperation     bool     `json:"read_only_operation"`
	Supported             bool     `json:"supported"`
	Enabled               bool     `json:"enabled"`
	Available             *bool    `json:"available"`
	Mutable               bool     `json:"mutable"`
	DisabledReason        string   `json:"disabled_reason,omitempty"`
	UnavailableReason     string   `json:"unavailable_reason,omitempty"`
	MutationBlockedReason string   `json:"mutation_blocked_reason,omitempty"`
}

// DiscoveryData is GET /v1/capabilities metadata; it does not promise request success.
type DiscoveryData struct {
	APIVersion        string                `json:"api_version"`
	SchemaVersion     uint32                `json:"schema_version"`
	SoftwareVersion   string                `json:"software_version"`
	ConfigSchema      string                `json:"config_schema"`
	ReadOnly          bool                  `json:"read_only"`
	AvailabilityScope string                `json:"availability_scope"`
	Operations        []OperationCapability `json:"operations"`
}

// ConfigFieldAPI describes a field's permitted API surfaces.
type ConfigFieldAPI struct {
	ConfigRead        bool     `json:"config_read"`
	ConfigWrite       bool     `json:"config_write"`
	ReadRoutes        []string `json:"read_routes"`
	WriteRoutes       []string `json:"write_routes"`
	RequestField      string   `json:"request_field,omitempty"`
	NonEditableReason string   `json:"non_editable_reason,omitempty"`
	NullBehavior      string   `json:"null_behavior"`
}

// ConfigField describes one canonical schema path. Value and Default retain u64 precision.
type ConfigField struct {
	Path         string          `json:"path"`
	Value        json.RawMessage `json:"value"`
	DefaultKind  string          `json:"default_kind"`
	Default      json.RawMessage `json:"default,omitempty"`
	Sensitivity  string          `json:"sensitivity"`
	Description  string          `json:"description"`
	Aliases      []string        `json:"aliases,omitempty"`
	Unit         string          `json:"unit,omitempty"`
	Apply        json.RawMessage `json:"apply"`
	Dependencies []string        `json:"dependencies,omitempty"`
	Constraints  []string        `json:"constraints,omitempty"`
	API          ConfigFieldAPI  `json:"api"`
}

// ConfigSchemaData describes type defaults and editability, never active secret values.
type ConfigSchemaData struct {
	SchemaVersion      uint32          `json:"schema_version"`
	ValueSchemaDialect string          `json:"value_schema_dialect"`
	DefaultsScope      string          `json:"defaults_scope"`
	ValidationScope    string          `json:"validation_scope"`
	PathNotation       string          `json:"path_notation"`
	ConfigPatch        json.RawMessage `json:"config_patch"`
	Fields             []ConfigField   `json:"fields"`
}

// Discovery calls the optional, read-only GET /v1/capabilities route.
func (c *Client) Discovery(ctx context.Context) (DiscoveryData, error) {
	return get[DiscoveryData](ctx, c, "/v1/capabilities")
}

// ConfigSchema caches successful schema metadata for five minutes and invalidates
// it on an observed version change. Failures are never cached as missing fields.
func (c *Client) ConfigSchema(ctx context.Context) (ConfigSchemaData, error) {
	c.capsMu.Lock()
	generation := c.capsGeneration
	if c.schemaValid && c.schemaGeneration == generation && c.now().Before(c.schemaAt.Add(capabilityCacheTTL)) {
		schema := c.schema
		c.capsMu.Unlock()
		return schema, nil
	}
	c.capsMu.Unlock()
	schema, err := get[ConfigSchemaData](ctx, c, "/v1/config/schema")
	if err == nil {
		c.capsMu.Lock()
		if c.capsGeneration == generation {
			c.schema = schema
			c.schemaAt = c.now()
			c.schemaGeneration = generation
			c.schemaValid = true
		}
		c.capsMu.Unlock()
	}
	return schema, err
}

func optionalRouteAbsent(err error) bool {
	if apiErr, ok := err.(*APIError); ok {
		return apiErr.Status == http.StatusNotFound || apiErr.Status == http.StatusMethodNotAllowed
	}
	return false
}
