package telemt

import "context"

// ZeroAll calls GET /v1/stats/zero/all — the deep counter dump. Display-only
// (07-telemt-sdk.md §Stats/runtime): callers should render it, not branch on it.
func (c *Client) ZeroAll(ctx context.Context) (ZeroAllData, error) {
	return get[ZeroAllData](ctx, c, "/v1/stats/zero/all")
}

// Upstreams calls GET /v1/stats/upstreams.
func (c *Client) Upstreams(ctx context.Context) (UpstreamsData, error) {
	return get[UpstreamsData](ctx, c, "/v1/stats/upstreams")
}

// DCs calls GET /v1/stats/dcs.
func (c *Client) DCs(ctx context.Context) (DcStatusData, error) {
	return get[DcStatusData](ctx, c, "/v1/stats/dcs")
}

// MeWriters calls GET /v1/stats/me-writers.
func (c *Client) MeWriters(ctx context.Context) (MeWritersData, error) {
	return get[MeWritersData](ctx, c, "/v1/stats/me-writers")
}

// MinimalAll calls GET /v1/stats/minimal/all. Gated behind
// minimal_runtime_enabled (default true).
func (c *Client) MinimalAll(ctx context.Context) (Gated[MinimalAllPayload], error) {
	return get[Gated[MinimalAllPayload]](ctx, c, "/v1/stats/minimal/all")
}

// ActiveIPs calls GET /v1/stats/users/active-ips. Only users with at least
// one active IP are listed (07-telemt-sdk.md §Users).
func (c *Client) ActiveIPs(ctx context.Context) ([]UserActiveIps, error) {
	return get[[]UserActiveIps](ctx, c, "/v1/stats/users/active-ips")
}
