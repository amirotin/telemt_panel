package telemt

import "context"

// Gates calls GET /v1/runtime/gates. This group is always enabled (07-telemt-sdk.md
// §Stats/runtime) so, unlike most of the runtime/* group, the response is a
// flat struct rather than a Gated[T] wrapper.
func (c *Client) Gates(ctx context.Context) (RuntimeGatesData, error) {
	return get[RuntimeGatesData](ctx, c, "/v1/runtime/gates")
}

// Initialization calls GET /v1/runtime/initialization. Always enabled, flat
// response — see Gates.
func (c *Client) Initialization(ctx context.Context) (RuntimeInitializationData, error) {
	return get[RuntimeInitializationData](ctx, c, "/v1/runtime/initialization")
}

// MePoolState calls GET /v1/runtime/me-pool-state. Gated: closed (data nil)
// when the ME pool has not started yet (reason "source_unavailable").
func (c *Client) MePoolState(ctx context.Context) (Gated[RuntimeMePoolStatePayload], error) {
	return get[Gated[RuntimeMePoolStatePayload]](ctx, c, "/v1/runtime/me-pool-state")
}

// MeQuality calls GET /v1/runtime/me-quality. Gated like MePoolState.
func (c *Client) MeQuality(ctx context.Context) (Gated[RuntimeMeQualityPayload], error) {
	return get[Gated[RuntimeMeQualityPayload]](ctx, c, "/v1/runtime/me-quality")
}

// UpstreamQuality calls GET /v1/runtime/upstream-quality. Its own bespoke
// shape (policy/counters always present, summary/upstreams independently
// optional) rather than Gated[T] — see RuntimeUpstreamQualityData's doc comment.
func (c *Client) UpstreamQuality(ctx context.Context) (RuntimeUpstreamQualityData, error) {
	return get[RuntimeUpstreamQualityData](ctx, c, "/v1/runtime/upstream-quality")
}

// NatStun calls GET /v1/runtime/nat-stun. Gated like MePoolState.
func (c *Client) NatStun(ctx context.Context) (Gated[RuntimeNatStunPayload], error) {
	return get[Gated[RuntimeNatStunPayload]](ctx, c, "/v1/runtime/nat-stun")
}

// MeSelfTest calls GET /v1/runtime/me-selftest. Gated like MePoolState; no
// hyphen/underscore alias exists for this one route (mod.rs only registers
// the hyphenated form).
func (c *Client) MeSelfTest(ctx context.Context) (Gated[RuntimeMeSelftestPayload], error) {
	return get[Gated[RuntimeMeSelftestPayload]](ctx, c, "/v1/runtime/me-selftest")
}

// EffectiveLimits calls GET /v1/limits/effective — note the route path
// itself, not /v1/runtime/limits/effective (verified against mod.rs's route
// table; 07-telemt-sdk.md's grouping is conceptual, not path-literal).
// Always enabled, flat response — see Gates.
func (c *Client) EffectiveLimits(ctx context.Context) (EffectiveLimitsData, error) {
	return get[EffectiveLimitsData](ctx, c, "/v1/limits/effective")
}
