package geography

import (
	"context"
	"errors"
	"time"
)

func (s *Service) pruneLocked(now time.Time, e epochs) {
	kept := s.cache[:0]
	for _, entry := range s.cache {
		age := now.Sub(entry.created)
		if entry.epochs == e && age >= 0 && age < 120*time.Second {
			kept = append(kept, entry)
		}
	}
	for i := len(kept); i < len(s.cache); i++ {
		s.cache[i] = nil
	}
	s.cache = kept
}
func (s *Service) promoteLocked(index int) *snapshot {
	entry := s.cache[index]
	copy(s.cache[1:index+1], s.cache[:index])
	s.cache[0] = entry
	return entry
}

func (s *Service) pinned(id string) (*snapshot, error) {
	if id == "" || len(id) > 160 {
		return nil, ErrBadRequest
	}
	e := s.currentEpochs()
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked(now, e)
	for i, entry := range s.cache {
		if entry.id == id {
			return s.promoteLocked(i), nil
		}
	}
	return nil, ErrSnapshotExpired
}

func (s *Service) acquire(ctx context.Context, k key) (*snapshot, error) {
	ctx, cancel := context.WithTimeout(ctx, s.deps.RequestTimeout)
	defer cancel()
	enrolled := false
	defer func() {
		if enrolled {
			s.mu.Lock()
			s.waiters--
			if s.waiters == 0 && s.work != nil {
				s.work.cancel()
			}
			s.mu.Unlock()
		}
	}()
	for {
		if err := ctx.Err(); err != nil {
			return nil, normalizeTimeout(err)
		}
		e := s.currentEpochs()
		now := s.now()
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			return nil, context.Canceled
		}
		s.pruneLocked(now, e)
		reuse := 10 * time.Second
		if k.window != "now" {
			reuse = 60 * time.Second
		}
		for i, entry := range s.cache {
			if entry.key == k && now.Sub(entry.created) < reuse {
				entry = s.promoteLocked(i)
				s.mu.Unlock()
				return entry, nil
			}
		}
		if !enrolled {
			if s.waiters >= 8 {
				s.mu.Unlock()
				return nil, ErrBusy
			}
			s.waiters++
			enrolled = true
		}
		if s.work == nil {
			buildCtx, buildCancel := context.WithTimeout(s.ctx, s.deps.BuildTimeout)
			work := &buildWork{key: k, done: make(chan struct{}), cancel: buildCancel}
			s.work = work
			s.wg.Add(1)
			go s.runBuild(buildCtx, work)
		}
		work := s.work
		s.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, normalizeTimeout(ctx.Err())
		case <-s.ctx.Done():
			return nil, context.Canceled
		case <-work.done:
			if work.key == k && work.err != nil && !errors.Is(work.err, context.Canceled) {
				return nil, normalizeTimeout(work.err)
			}
		}
	}
}

func normalizeTimeout(err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return ErrTimeout
	}
	return err
}

func (s *Service) runBuild(ctx context.Context, work *buildWork) {
	defer s.wg.Done()
	defer work.cancel()
	result, err := s.build(ctx, work.key)
	if err == nil && result.epochs != s.currentEpochs() {
		err = ErrSourceChanged
	}
	if err == nil && ctx.Err() != nil {
		err = ctx.Err()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed && err == nil {
		err = context.Canceled
	}
	if err == nil {
		if result.data.OwnedBytes+2048 > 32<<20 {
			err = ErrCapacity
		} else {
			var owned int64
			for _, entry := range s.cache {
				owned += entry.data.OwnedBytes + 2048
			}
			for len(s.cache) > 0 && (len(s.cache) >= 2 || owned+result.data.OwnedBytes+2048 > 32<<20) {
				last := s.cache[len(s.cache)-1]
				owned -= last.data.OwnedBytes + 2048
				s.cache[len(s.cache)-1] = nil
				s.cache = s.cache[:len(s.cache)-1]
			}
			s.cache = append([]*snapshot{result}, s.cache...)
		}
	}
	work.result, work.err = result, err
	s.work = nil
	close(work.done)
}
