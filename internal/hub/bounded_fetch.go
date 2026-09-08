package hub

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

const maxConcurrentSDKFetches = 3

type fetchAttempt struct {
	attempted bool
	err       error
}

func (a fetchAttempt) succeeded() bool {
	return a.attempted && a.err == nil
}

type boundedFetchGroup struct {
	ctx  context.Context
	jobs []func(context.Context)
}

func newBoundedFetchGroup(ctx context.Context) *boundedFetchGroup {
	return &boundedFetchGroup{ctx: ctx}
}

func (g *boundedFetchGroup) add(attempt *fetchAttempt, fetch func(context.Context) error) {
	g.jobs = append(g.jobs, func(ctx context.Context) {
		attempt.attempted = true
		attempt.err = fetch(ctx)
	})
}

// wait executes jobs in enqueue order with at most three active SDK calls.
// Jobs that cannot start before ctx expires remain explicitly unattempted.
func (g *boundedFetchGroup) wait() {
	workers := min(maxConcurrentSDKFetches, len(g.jobs))
	var mu sync.Mutex
	next := 0
	var wg sync.WaitGroup
	wg.Add(workers)
	for range workers {
		go func() {
			defer wg.Done()
			for {
				mu.Lock()
				if g.ctx.Err() != nil || next == len(g.jobs) {
					mu.Unlock()
					return
				}
				job := g.jobs[next]
				next++
				mu.Unlock()
				job(g.ctx)
			}
		}()
	}
	wg.Wait()
}

func noSuccessfulPrimaryError(prefix string, ctx context.Context, attempts ...fetchAttempt) error {
	errs := make([]error, 0, len(attempts)+1)
	for _, attempt := range attempts {
		if attempt.attempted && attempt.err != nil {
			errs = append(errs, attempt.err)
		}
	}
	if len(errs) == 0 {
		if err := ctx.Err(); err != nil {
			errs = append(errs, err)
		} else {
			errs = append(errs, errors.New("no primary source completed"))
		}
	}
	return fmt.Errorf("%s: %w", prefix, errors.Join(errs...))
}
