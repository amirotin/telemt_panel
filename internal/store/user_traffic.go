package store

import (
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
)

const (
	userTrafficBatchRows        = 200
	userTrafficCollectorPeriod  = 30 * time.Second
	userTrafficUncertainGap     = 24 * time.Hour
	userTrafficMemoryRetention  = 24 * time.Hour
	userTrafficMemoryMaxBuckets = 100_000
)

func validateUserTrafficSnapshot(snapshot UserTrafficSnapshot) error {
	if snapshot.ObservedAt <= 0 {
		return errors.New("user traffic snapshot observed time must be positive")
	}
	if snapshot.SourceStartedAt <= 0 {
		return errors.New("user traffic snapshot source start is invalid")
	}
	seen := make(map[string]struct{}, len(snapshot.Users))
	for _, user := range snapshot.Users {
		if strings.TrimSpace(user.Username) == "" {
			return errors.New("user traffic snapshot contains an empty username")
		}
		if _, duplicate := seen[user.Username]; duplicate {
			return fmt.Errorf("user traffic snapshot contains duplicate username %q", user.Username)
		}
		seen[user.Username] = struct{}{}
		if _, err := userTrafficInt64(user.RawOctets); err != nil {
			return fmt.Errorf("user %q: %w", user.Username, err)
		}
	}
	return nil
}

func userTrafficInt64(value uint64) (int64, error) {
	if value > math.MaxInt64 {
		return 0, errors.New("raw traffic exceeds int64")
	}
	return int64(value), nil
}

func utcMonthKey(ts int64) int {
	t := time.Unix(ts, 0).UTC()
	return t.Year()*100 + int(t.Month())
}

func nextUserTrafficContinuity(previous UserTrafficCollectorState, found bool, snapshot UserTrafficSnapshot) UserTrafficContinuity {
	continuity := UserTrafficNormal
	if found {
		continuity = previous.Continuity
		gap := time.Duration(snapshot.ObservedAt-previous.LastSuccessTS) * time.Second
		if gap > userTrafficUncertainGap ||
			(snapshot.SourceStartedAt != previous.SourceStartedAt && gap > 2*userTrafficCollectorPeriod) {
			continuity = UserTrafficPartial
		}
	}
	if !snapshot.TelemetryEnabled {
		continuity = UserTrafficPartial
	}
	return continuity
}

func userTrafficSourceState(enabled bool) UserTrafficSourceState {
	if enabled {
		return UserTrafficCollecting
	}
	return UserTrafficPaused
}
