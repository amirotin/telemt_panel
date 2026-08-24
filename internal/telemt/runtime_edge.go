package telemt

import (
	"context"
	"strconv"
)

// ConnectionsSummary calls GET /v1/runtime/connections/summary. Gated behind
// runtime_edge_enabled (default false in Telemt) — closed by default, not an
// error (07-telemt-sdk.md §Stats/runtime, "Группа runtime edge").
func (c *Client) ConnectionsSummary(ctx context.Context) (Gated[RuntimeEdgeConnectionsSummaryPayload], error) {
	return get[Gated[RuntimeEdgeConnectionsSummaryPayload]](ctx, c, "/v1/runtime/connections/summary")
}

// RecentEvents calls GET /v1/runtime/events/recent?limit=. limit <= 0 omits
// the query parameter and lets Telemt apply its own default (50, capped at
// 1000 — runtime_edge.rs EVENTS_DEFAULT_LIMIT/EVENTS_MAX_LIMIT). Gated
// behind runtime_edge_enabled like ConnectionsSummary.
func (c *Client) RecentEvents(ctx context.Context, limit int) (Gated[RuntimeEdgeEventsPayload], error) {
	path := "/v1/runtime/events/recent"
	if limit > 0 {
		path += "?limit=" + strconv.Itoa(limit)
	}
	return get[Gated[RuntimeEdgeEventsPayload]](ctx, c, path)
}

// TLSFingerprints calls GET /v1/runtime/tls-fingerprints?limit=. limit <= 0
// omits the query parameter and lets Telemt apply its own default. Gated
// behind runtime_edge_enabled like ConnectionsSummary.
func (c *Client) TLSFingerprints(ctx context.Context, limit int) (Gated[RuntimeEdgeTLSFingerprintsPayload], error) {
	path := "/v1/runtime/tls-fingerprints"
	if limit > 0 {
		path += "?limit=" + strconv.Itoa(limit)
	}
	return get[Gated[RuntimeEdgeTLSFingerprintsPayload]](ctx, c, path)
}
