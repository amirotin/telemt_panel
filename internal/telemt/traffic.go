package telemt

import (
	"context"
	"errors"
	"fmt"
)

// ErrInconsistentTrafficSnapshot means Telemt restarted or reloaded its
// configuration while the composite traffic observation was being assembled.
var ErrInconsistentTrafficSnapshot = errors.New("telemt traffic snapshot changed during collection")

// TrafficSnapshot is a coherent view of the process identity, telemetry state
// and every configured user's raw counter.
type TrafficSnapshot struct {
	ObservedAt       int64
	SourceStartedAt  int64
	TelemetryEnabled bool
	Users            []UserInfo
}

// TrafficSnapshot reads process identity around the security and users calls.
// Matching process IDs and config revisions prevent an old users payload from
// being paired with a new Telemt uptime after a concurrent restart or reload.
func (c *Client) TrafficSnapshot(ctx context.Context) (TrafficSnapshot, error) {
	before, beforeRevision, err := getRevision[SystemInfoData](ctx, c, "/v1/system/info")
	if err != nil {
		return TrafficSnapshot{}, err
	}
	posture, postureRevision, err := getRevision[SecurityPostureData](ctx, c, "/v1/security/posture")
	if err != nil {
		return TrafficSnapshot{}, err
	}
	users, usersRevision, err := getRevision[[]UserInfo](ctx, c, "/v1/users")
	if err != nil {
		return TrafficSnapshot{}, err
	}
	after, afterRevision, err := getRevision[SystemInfoData](ctx, c, "/v1/system/info")
	if err != nil {
		return TrafficSnapshot{}, err
	}
	if before.ProcessStartedAtEpochSec <= 0 ||
		before.ProcessStartedAtEpochSec != after.ProcessStartedAtEpochSec ||
		beforeRevision == "" ||
		beforeRevision != postureRevision ||
		beforeRevision != usersRevision ||
		beforeRevision != afterRevision {
		return TrafficSnapshot{}, fmt.Errorf("%w: process or revision mismatch", ErrInconsistentTrafficSnapshot)
	}
	return TrafficSnapshot{
		ObservedAt:       c.now().Unix(),
		SourceStartedAt:  before.ProcessStartedAtEpochSec,
		TelemetryEnabled: posture.TelemetryUserEnabled,
		Users:            users,
	}, nil
}
