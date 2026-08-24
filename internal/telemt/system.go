package telemt

import (
	"context"
	"net/http"
	"strconv"
)

// Ready calls GET /v1/health/ready. Telemt answers with the normal success
// envelope on both 200 and 503 — see callRevision's doc comment — so this
// never returns an *APIError purely because admission is closed or no
// upstream is healthy; check ReadyData.Ready instead.
func (c *Client) Ready(ctx context.Context) (ReadyData, error) {
	return get[ReadyData](ctx, c, "/v1/health/ready")
}

// Reload calls POST /v1/system/reload. revision, when non-empty, is sent as
// If-Match; a mismatch surfaces as a revision_conflict *APIError. Returns
// the response envelope's revision alongside the accepted reload's own
// config_revision (ReloadAccepted.ConfigRevision) — both are typically the
// same value, but the envelope's is what a subsequent mutation's If-Match
// should chain from (07-telemt-sdk.md §SDK-5).
func (c *Client) Reload(ctx context.Context, req ReloadRequest, revision string) (ReloadAccepted, string, error) {
	return mutateRevision[ReloadAccepted](ctx, c, http.MethodPost, "/v1/system/reload", req, revision)
}

// ReloadStatus calls GET /v1/system/reload/{id} to poll a previously
// submitted reload. A 404 not_found-shaped *APIError (Telemt's actual code
// is "reload_not_found", not the generic "not_found" — see the task-1
// report's discrepancy note) means the id is unknown or has aged out of the
// last-32 history.
func (c *Client) ReloadStatus(ctx context.Context, reloadID uint64) (ReloadStatus, error) {
	return get[ReloadStatus](ctx, c, "/v1/system/reload/"+strconv.FormatUint(reloadID, 10))
}
