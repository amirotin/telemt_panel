package store

import (
	"context"
	"errors"
	"math"
	"slices"
)

// TrafficTierPolicy describes the retained resolution of traffic buckets.
type TrafficTierPolicy struct {
	Tier                     MetricTier
	WidthSecs, RetentionSecs int64
}

// TrafficWindow selects bucket starts in one non-overlapping tier interval.
type TrafficWindow struct {
	Tier     MetricTier
	From, To int64
}

// TrafficCoverage describes available boundary resolution, independently of
// collector continuity or whether any traffic was observed in the interval.
type TrafficCoverage struct {
	AsOfEpochSecs        int64  `json:"as_of_epoch_secs"`
	BoundaryPartial      bool   `json:"boundary_partial"`
	CoveredFromEpochSecs *int64 `json:"covered_from_epoch_secs"`
	CoveredToEpochSecs   *int64 `json:"covered_to_epoch_secs"`
}

// TrafficReadSnapshot holds one consistent view of traffic and collector state.
// Close must run before serializing a response or doing external I/O.
type TrafficReadSnapshot interface {
	AsOf() int64
	CollectorState() (UserTrafficCollectorState, error)
	Summaries() (map[string]UserTrafficSummary, error)
	Range(username string, from, to int64) ([]UserTrafficPoint, TrafficCoverage, error)
	Aggregate(from, to int64) (int64, []UserTrafficPoint, TrafficCoverage, error)
	Ranking(from, to int64, includeDeleted bool, limit int, cursor *UserTrafficRankCursor) ([]UserTrafficRank, TrafficCoverage, error)
	Close() error
}

// PlanTrafficWindows preserves complete finer buckets on partial coarse
// boundaries without counting a coarse bucket together with its children.
func PlanTrafficWindows(from, to, asOf int64, tiers []TrafficTierPolicy) ([]TrafficWindow, TrafficCoverage, error) {
	coverage := TrafficCoverage{AsOfEpochSecs: asOf}
	if from > to {
		return nil, coverage, errors.New("traffic range is reversed")
	}
	policies := slices.Clone(tiers)
	slices.SortFunc(policies, func(a, b TrafficTierPolicy) int {
		if a.WidthSecs < b.WidthSecs {
			return -1
		}
		if a.WidthSecs > b.WidthSecs {
			return 1
		}
		return 0
	})
	seen := make(map[MetricTier]bool, len(policies))
	for i, tier := range policies {
		if tier.WidthSecs <= 0 || tier.RetentionSecs < 0 || seen[tier.Tier] || (i > 0 && (tier.WidthSecs == policies[i-1].WidthSecs || tier.WidthSecs%policies[i-1].WidthSecs != 0)) {
			return nil, coverage, errors.New("invalid traffic tier policy")
		}
		seen[tier.Tier] = true
	}
	windows := make([]TrafficWindow, 0)
	end := min(to, asOf)
	if from >= end {
		coverage.BoundaryPartial = from < to
		return windows, coverage, nil
	}
	cursor := from
	for cursor < end {
		next := int64(math.MaxInt64)
		chosen := -1
		bucketEnd := int64(0)
		for i, tier := range policies {
			if tier.RetentionSecs == 0 {
				continue
			}
			cutoff := int64(math.MinInt64)
			if asOf >= math.MinInt64+tier.RetentionSecs {
				cutoff = asOf - tier.RetentionSecs
			}
			start, ok := ceilTrafficBoundary(max(cursor, cutoff), tier.WidthSecs)
			if !ok || start >= end {
				continue
			}
			finish := int64(math.MaxInt64)
			if start <= math.MaxInt64-tier.WidthSecs {
				finish = start + tier.WidthSecs
			}
			if finish > end && to < asOf {
				continue
			}
			if start < next {
				next, chosen, bucketEnd = start, i, min(finish, end)
			}
		}
		if chosen == -1 {
			coverage.BoundaryPartial = true
			break
		}
		if next > cursor {
			coverage.BoundaryPartial = true
		}
		if coverage.CoveredFromEpochSecs == nil {
			first := next
			coverage.CoveredFromEpochSecs = &first
		}
		last := bucketEnd
		coverage.CoveredToEpochSecs = &last
		tier := policies[chosen].Tier
		if len(windows) > 0 && windows[len(windows)-1].Tier == tier && windows[len(windows)-1].To == next {
			windows[len(windows)-1].To = bucketEnd
		} else {
			windows = append(windows, TrafficWindow{Tier: tier, From: next, To: bucketEnd})
		}
		cursor = bucketEnd
	}
	if to > asOf {
		coverage.BoundaryPartial = true
	}
	return windows, coverage, nil
}

func ceilTrafficBoundary(ts, width int64) (int64, bool) {
	remainder := ts % width
	if remainder == 0 {
		return ts, true
	}
	if remainder < 0 {
		return ts - remainder, true
	}
	delta := width - remainder
	if ts > math.MaxInt64-delta {
		return 0, false
	}
	return ts + delta, true
}

func trafficWindowContains(windows []TrafficWindow, tier MetricTier, ts int64) bool {
	for _, window := range windows {
		if window.Tier == tier && ts >= window.From && ts < window.To {
			return true
		}
	}
	return false
}

func trafficContextError(ctx context.Context, closed bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if closed {
		return errors.New("traffic snapshot is closed")
	}
	return nil
}
