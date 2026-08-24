package telemt

import "context"

// Posture calls GET /v1/security/posture.
func (c *Client) Posture(ctx context.Context) (SecurityPostureData, error) {
	return get[SecurityPostureData](ctx, c, "/v1/security/posture")
}

// Whitelist calls GET /v1/security/whitelist.
func (c *Client) Whitelist(ctx context.Context) (SecurityWhitelistData, error) {
	return get[SecurityWhitelistData](ctx, c, "/v1/security/whitelist")
}
