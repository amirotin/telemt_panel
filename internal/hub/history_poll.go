package hub

import (
	"context"
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
	var health telemt.HealthData
	var summary telemt.SummaryData
	var ready telemt.ReadyData
	var healthAttempt, summaryAttempt, readyAttempt fetchAttempt
	group := newBoundedFetchGroup(ctx)
	group.add(&healthAttempt, func(ctx context.Context) error {
		var err error
		health, err = tc.Health(ctx)
		return err
	})
	group.add(&summaryAttempt, func(ctx context.Context) error {
		var err error
		summary, err = tc.StatsSummary(ctx)
		return err
	})
	group.add(&readyAttempt, func(ctx context.Context) error {
		var err error
		ready, err = tc.Ready(ctx)
		return err
	})
	group.wait()
	if healthAttempt.succeeded() {
		snap.Health = &health
	}
	if summaryAttempt.succeeded() {
		snap.Summary = &summary
	}
	if readyAttempt.succeeded() {
		snap.Ready = &ready
	}
	if !healthAttempt.succeeded() && !summaryAttempt.succeeded() && !readyAttempt.succeeded() {
		return statsSnapshot{}, noSuccessfulPrimaryError("stats", ctx, healthAttempt, summaryAttempt, readyAttempt)
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
	var gates telemt.RuntimeGatesData
	var quality telemt.RuntimeUpstreamQualityData
	var gatesAttempt, qualityAttempt fetchAttempt
	group := newBoundedFetchGroup(ctx)
	group.add(&gatesAttempt, func(ctx context.Context) error {
		var err error
		gates, err = tc.Gates(ctx)
		return err
	})
	group.add(&qualityAttempt, func(ctx context.Context) error {
		var err error
		quality, err = tc.UpstreamQuality(ctx)
		return err
	})
	group.wait()
	if gatesAttempt.succeeded() {
		value := gates
		result.snapshot.Gates = &value
	} else {
		result.gatesErr = gatesAttempt.err
	}
	if qualityAttempt.succeeded() {
		value := quality
		result.snapshot.UpstreamQuality = &value
	} else {
		result.qualityErr = qualityAttempt.err
	}
	return result
}

func fetchRuntimeHistory(ctx context.Context, tc *telemt.Client) (runtimeSnapshot, error) {
	result := collectRuntimeHistoryInputs(ctx, tc)
	if result.snapshot.Gates == nil && result.snapshot.UpstreamQuality == nil {
		return runtimeSnapshot{}, noSuccessfulPrimaryError("runtime history", ctx,
			fetchAttempt{attempted: result.gatesErr != nil, err: result.gatesErr},
			fetchAttempt{attempted: result.qualityErr != nil, err: result.qualityErr},
		)
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
