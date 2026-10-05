package httpapi

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
)

func TestLogStreamRegistryAtomicQuotaAndRelease(t *testing.T) {
	r := newLogStreamRegistry()
	defer r.Close()
	var admitted atomic.Int32
	var wg sync.WaitGroup
	var releaseMu sync.Mutex
	var releases []func()
	start := make(chan struct{})
	for i := range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			key := string(rune('a' + i%3))
			release, err := r.TryRegister(key, func() {})
			if err == nil {
				admitted.Add(1)
				releaseMu.Lock()
				releases = append(releases, release)
				releaseMu.Unlock()
			} else if !errors.Is(err, ErrLogStreamLimit) {
				t.Errorf("unexpected admission error=%v", err)
			}
		}()
	}
	close(start)
	wg.Wait()
	if admitted.Load() != 4 {
		t.Fatalf("admitted=%d, want4", admitted.Load())
	}
	for _, release := range releases {
		release()
		release()
	}
	if len(r.active) != 0 {
		t.Fatal("repeated release leaked registrations")
	}
	ctx, cancel := context.WithCancel(context.Background())
	release, err := r.TryRegister("", cancel)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	r.Close()
	r.Close()
	if ctx.Err() == nil {
		t.Fatal("Close did not cancel source")
	}
	if _, err := r.TryRegister("later", func() {}); err == nil {
		t.Fatal("closed registry admitted source")
	}
}
