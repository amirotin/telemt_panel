package store

import (
	"context"
	"errors"

	"github.com/amirotin/telemt_panel/internal/atomicfile"
)

func (s *Composite) ApplyUserIPBatchContext(ctx context.Context, batch UserIPBatch) error {
	return s.history.ApplyUserIPBatchContext(ctx, batch)
}
func (s *Composite) ResetUserIPHistoryContext(ctx context.Context, username string) error {
	return s.history.ResetUserIPHistoryContext(ctx, username)
}

func (s *Composite) RecordMetricsContext(ctx context.Context, points []NamedMetricPoint) error {
	return s.history.RecordMetricsContext(ctx, points)
}
func (s *Composite) MetricRangeContext(ctx context.Context, name string, from int64) ([]MetricPoint, error) {
	return s.history.MetricRangeContext(ctx, name, from)
}
func (s *Composite) ApplyUserTrafficSnapshotContext(ctx context.Context, snapshot UserTrafficSnapshot) (UserTrafficApplyResult, error) {
	return s.history.ApplyUserTrafficSnapshotContext(ctx, snapshot)
}
func (s *Composite) AppendHistoryEventContext(ctx context.Context, event HistoryEvent) error {
	return s.history.AppendHistoryEventContext(ctx, event)
}
func (s *Composite) ListHistoryEventsContext(ctx context.Context, filter HistoryEventFilter) ([]HistoryEvent, error) {
	return s.history.ListHistoryEventsContext(ctx, filter)
}
func (s *Composite) DeleteUserHistoryContext(ctx context.Context, username string) error {
	return s.history.DeleteUserHistoryContext(ctx, username)
}
func (s *Composite) ResetUserTrafficContext(ctx context.Context) error {
	return s.history.ResetUserTrafficContext(ctx)
}
func (s *Composite) PurgeHistoryContext(ctx context.Context, category StorageCategory) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if category == StorageAudit {
		return s.state.PurgeAudit()
	}
	return s.history.PurgeHistoryContext(ctx, category)
}
func (s *Composite) ApplyStoragePoliciesContext(ctx context.Context, policies []StoragePolicy) error {
	return s.ReplaceStoragePoliciesContext(ctx, policies)
}
func (s *Composite) ReplaceStoragePoliciesContext(parent context.Context, policies []StoragePolicy) error {
	ctx, cancel := historyOperationContext(parent)
	defer cancel()
	if err := lockHistoryMutex(ctx, &s.policyMu); err != nil {
		return err
	}
	defer s.policyMu.Unlock()
	if err := ValidateStoragePolicies(policies); err != nil {
		return err
	}
	previous, err := s.state.ListStoragePolicies()
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	stateErr := s.state.ReplaceStoragePolicies(policies)
	if stateErr != nil && !atomicfile.Published(stateErr) {
		return stateErr
	}
	if err := s.history.ApplyStoragePoliciesContext(ctx, policies); err != nil {
		// Roll back the idempotent policy change in a fresh bounded scope even
		// when the caller canceled its original operation.
		rollbackCtx, rollbackCancel := historyOperationContext(context.Background())
		defer rollbackCancel()
		return errors.Join(stateErr, err, s.history.ApplyStoragePoliciesContext(rollbackCtx, previous), s.state.ReplaceStoragePolicies(previous))
	}
	return stateErr
}
func (s *Composite) StorageStatsContext(ctx context.Context) (StorageStats, error) {
	stats, err := s.history.StorageStatsContext(ctx)
	if err != nil {
		return StorageStats{}, err
	}
	if err := ctx.Err(); err != nil {
		return StorageStats{}, err
	}
	audit, err := s.state.ListAudit(0)
	if err != nil {
		return StorageStats{}, err
	}
	for i := range stats.Categories {
		if stats.Categories[i].Category == StorageAudit {
			stats.Categories[i].Records = int64(len(audit))
		}
	}
	return stats, nil
}
