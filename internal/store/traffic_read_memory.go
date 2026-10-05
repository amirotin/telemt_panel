package store

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"maps"
	"math"
	"slices"
	"strings"
	"time"
)

type memoryTrafficReadSnapshot struct {
	ctx       context.Context
	cancel    context.CancelFunc
	asOf      int64
	collector UserTrafficCollectorState
	summaries map[string]UserTrafficSummary
	buckets   map[memoryUserTrafficBucketKey]int64
	tiers     []TrafficTierPolicy
	closed    bool
}

// BeginTrafficRead copies bounded traffic data under one lock.
func (m *Memory) BeginTrafficRead(parent context.Context) (TrafficReadSnapshot, error) {
	ctx, cancel := historyOperationContext(parent)
	if err := ctx.Err(); err != nil {
		cancel()
		return nil, err
	}
	if err := lockHistoryMutex(ctx, &m.mu); err != nil {
		cancel()
		return nil, err
	}
	defer m.mu.Unlock()
	r := &memoryTrafficReadSnapshot{ctx: ctx, cancel: cancel, asOf: time.Now().Unix(), collector: m.userTrafficCollector,
		summaries: make(map[string]UserTrafficSummary, len(m.userTraffic)), buckets: maps.Clone(m.userTrafficBuckets)}
	if !m.hasTrafficCollector {
		r.collector = UserTrafficCollectorState{SourceState: UserTrafficUnavailable, Continuity: UserTrafficNormal}
	}
	monthKey := utcMonthKey(r.asOf)
	for username, current := range m.userTraffic {
		summary := current.summary
		if summary.MonthKey != monthKey {
			summary.CurrentMonthBytes = 0
		}
		r.summaries[username] = summary
	}
	if m.policies[StorageUserTraffic].Enabled {
		r.tiers = []TrafficTierPolicy{{Tier: MetricTierQuarter, WidthSecs: 900, RetentionSecs: int64(userTrafficMemoryRetention / time.Second)}}
	}
	if err := ctx.Err(); err != nil {
		cancel()
		return nil, err
	}
	return r, nil
}

func (r *memoryTrafficReadSnapshot) AsOf() int64 { return r.asOf }
func (r *memoryTrafficReadSnapshot) Close() error {
	if r.closed {
		return nil
	}
	r.closed = true
	err := r.ctx.Err()
	r.cancel()
	return err
}
func (r *memoryTrafficReadSnapshot) CollectorState() (UserTrafficCollectorState, error) {
	return r.collector, trafficContextError(r.ctx, r.closed)
}
func (r *memoryTrafficReadSnapshot) Summaries() (map[string]UserTrafficSummary, error) {
	if err := trafficContextError(r.ctx, r.closed); err != nil {
		return nil, err
	}
	return maps.Clone(r.summaries), nil
}
func (r *memoryTrafficReadSnapshot) Range(username string, from, to int64) ([]UserTrafficPoint, TrafficCoverage, error) {
	windows, coverage, err := PlanTrafficWindows(from, to, r.asOf, r.tiers)
	if err != nil {
		return nil, coverage, err
	}
	if err := trafficContextError(r.ctx, r.closed); err != nil {
		return nil, coverage, err
	}
	points := make([]UserTrafficPoint, 0)
	for key, bytes := range r.buckets {
		if err := r.ctx.Err(); err != nil {
			return nil, coverage, err
		}
		if key.username == username && trafficWindowContains(windows, MetricTierQuarter, key.ts) {
			points = append(points, UserTrafficPoint{TS: key.ts, Bytes: bytes, Tier: MetricTierQuarter})
		}
	}
	slices.SortFunc(points, func(a, b UserTrafficPoint) int { return cmp.Compare(a.TS, b.TS) })
	return points, coverage, nil
}
func (r *memoryTrafficReadSnapshot) Aggregate(from, to int64) (int64, []UserTrafficPoint, TrafficCoverage, error) {
	windows, coverage, err := PlanTrafficWindows(from, to, r.asOf, r.tiers)
	if err != nil {
		return 0, nil, coverage, err
	}
	if err := trafficContextError(r.ctx, r.closed); err != nil {
		return 0, nil, coverage, err
	}
	byTS := make(map[int64]int64)
	var total int64
	for key, bytes := range r.buckets {
		if err := r.ctx.Err(); err != nil {
			return 0, nil, coverage, err
		}
		if !trafficWindowContains(windows, MetricTierQuarter, key.ts) {
			continue
		}
		if bytes > math.MaxInt64-total || bytes > math.MaxInt64-byTS[key.ts] {
			return 0, nil, coverage, errors.New("aggregate user traffic exceeds int64")
		}
		total += bytes
		byTS[key.ts] += bytes
	}
	points := make([]UserTrafficPoint, 0, len(byTS))
	for ts, bytes := range byTS {
		points = append(points, UserTrafficPoint{TS: ts, Bytes: bytes, Tier: MetricTierQuarter})
	}
	slices.SortFunc(points, func(a, b UserTrafficPoint) int { return cmp.Compare(a.TS, b.TS) })
	return total, points, coverage, nil
}
func (r *memoryTrafficReadSnapshot) Ranking(from, to int64, includeDeleted bool, limit int, cursor *UserTrafficRankCursor) ([]UserTrafficRank, TrafficCoverage, error) {
	windows, coverage, err := PlanTrafficWindows(from, to, r.asOf, r.tiers)
	if err != nil {
		return nil, coverage, err
	}
	if err := trafficContextError(r.ctx, r.closed); err != nil {
		return nil, coverage, err
	}
	period := make(map[string]int64)
	if limit > 0 {
		for key, bytes := range r.buckets {
			if err := r.ctx.Err(); err != nil {
				return nil, coverage, err
			}
			if !trafficWindowContains(windows, MetricTierQuarter, key.ts) {
				continue
			}
			if bytes > math.MaxInt64-period[key.username] {
				return nil, coverage, fmt.Errorf("user %q range traffic exceeds int64", key.username)
			}
			period[key.username] += bytes
		}
	}
	ranks := make([]UserTrafficRank, 0, len(period))
	for username, bytes := range period {
		summary := r.summaries[username]
		if bytes == 0 || (!includeDeleted && summary.DeletedEpochSecs != 0) {
			continue
		}
		if cursor != nil && (bytes > cursor.Bytes || (bytes == cursor.Bytes && username <= cursor.Username)) {
			continue
		}
		ranks = append(ranks, UserTrafficRank{Username: username, Bytes: bytes, ObservedTotal: summary.ObservedTotalBytes, CurrentMonth: summary.CurrentMonthBytes, DeletedEpochSecs: summary.DeletedEpochSecs, Continuity: summary.Continuity})
	}
	slices.SortFunc(ranks, func(a, b UserTrafficRank) int {
		if a.Bytes != b.Bytes {
			return cmp.Compare(b.Bytes, a.Bytes)
		}
		return strings.Compare(a.Username, b.Username)
	})
	if len(ranks) > limit && limit > 0 {
		ranks = ranks[:limit]
	}
	return ranks, coverage, nil
}
