package hub

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

type pollProfile uint8

const (
	pollFull pollProfile = iota
	pollHistory
)

type pollGateRecheck uint8

const (
	recheckNone pollGateRecheck = iota
	recheckSnapshot
	recheckHydration
)

type usersHistoryObservation struct {
	gauges usersLiveGauges
}

func fetchUsersObservation(ctx context.Context, tc *telemt.Client) ([]telemt.UserInfo, usersLiveGauges, error) {
	users, err := tc.Users(ctx)
	if err != nil {
		return nil, usersLiveGauges{}, err
	}
	if observe, ok := ctx.Value(ipObserverKey{}).(func([]telemt.UserInfo)); ok {
		observe(users)
	}
	var gauges usersLiveGauges
	for _, user := range users {
		gauges.addUser(user.CurrentConnections)
	}
	return users, gauges, nil
}

func fetchUsersHistory(ctx context.Context, tc *telemt.Client) (usersHistoryObservation, error) {
	_, gauges, err := fetchUsersObservation(ctx, tc)
	return usersHistoryObservation{gauges: gauges}, err
}

func fetchStatsHistory(ctx context.Context, tc *telemt.Client) (statsSnapshot, error) {
	var snap statsSnapshot
	health, healthErr := tc.Health(ctx)
	if healthErr == nil {
		snap.Health = &health
	}
	summary, summaryErr := tc.StatsSummary(ctx)
	if summaryErr == nil {
		snap.Summary = &summary
	}
	ready, readyErr := tc.Ready(ctx)
	if readyErr == nil {
		snap.Ready = &ready
	}
	if healthErr != nil && summaryErr != nil && readyErr != nil {
		return statsSnapshot{}, fmt.Errorf("stats: %w", errors.Join(healthErr, summaryErr, readyErr))
	}
	if caps, err := tc.Capabilities(ctx); err == nil && caps.RuntimeEdge {
		if cs, err := tc.ConnectionsSummary(ctx); err == nil {
			snap.ConnectionsSummary = &cs
		} else {
			slog.Warn("hub: stats topic: connections summary", "err", err)
		}
	}
	return snap, nil
}

type runtimeHistoryInputs struct {
	snapshot   runtimeSnapshot
	gatesErr   error
	qualityErr error
}

func collectRuntimeHistoryInputs(ctx context.Context, tc *telemt.Client) runtimeHistoryInputs {
	var result runtimeHistoryInputs
	if value, err := tc.Gates(ctx); err == nil {
		result.snapshot.Gates = &value
	} else {
		result.gatesErr = err
	}
	if value, err := tc.UpstreamQuality(ctx); err == nil {
		result.snapshot.UpstreamQuality = &value
	} else {
		result.qualityErr = err
	}
	return result
}

func fetchRuntimeHistory(ctx context.Context, tc *telemt.Client) (runtimeSnapshot, error) {
	result := collectRuntimeHistoryInputs(ctx, tc)
	if result.gatesErr != nil && result.qualityErr != nil {
		return runtimeSnapshot{}, fmt.Errorf("runtime history: %w", errors.Join(result.gatesErr, result.qualityErr))
	}
	return result.snapshot, nil
}

func fetchUpstreamsHistory(ctx context.Context, tc *telemt.Client) (upstreamsSnapshot, error) {
	dcs, err := tc.DCs(ctx)
	if err != nil {
		return upstreamsSnapshot{}, fmt.Errorf("upstreams history: %w", err)
	}
	return upstreamsSnapshot{DCs: &dcs}, nil
}

func newTopicGate() chan struct{} {
	gate := make(chan struct{}, 1)
	gate <- struct{}{}
	return gate
}

func acquireTopicGate(ctx context.Context, gate chan struct{}) bool {
	select {
	case <-ctx.Done():
		return false
	case <-gate:
		return true
	}
}

func releaseTopicGate(gate chan struct{}) {
	gate <- struct{}{}
}
