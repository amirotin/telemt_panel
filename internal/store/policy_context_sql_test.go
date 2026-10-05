//go:build !lite

package store

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestSQLitePolicyCancellationDuringIPBarrier(t *testing.T) {
	s, _ := newSQLite(t)
	before, err := s.ListStoragePolicies()
	if err != nil {
		t.Fatal(err)
	}
	next := append([]StoragePolicy(nil), before...)
	for i := range next {
		if next[i].Category == StorageUserIPHistory {
			next[i].RetentionDays++
		}
	}
	if err := ValidateStoragePolicies(next); err != nil {
		t.Fatal(err)
	}
	s.userIPMu.Lock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- s.ApplyStoragePoliciesContext(ctx, next) }()
	deadline := time.Now().Add(time.Second)
	for {
		if !s.liveMu.TryLock() {
			break
		}
		s.liveMu.Unlock()
		if time.Now().After(deadline) {
			s.userIPMu.Unlock()
			cancel()
			<-done
			t.Fatal("policy update did not reach the IP barrier")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		s.userIPMu.Unlock()
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation error=%v", err)
		}
	case <-time.After(500 * time.Millisecond):
		s.userIPMu.Unlock()
		<-done
		t.Error("cancelled policy update stayed blocked on IP mutex")
	}
	after, err := s.ListStoragePolicies()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Error("cancelled IP-barrier wait changed policies")
	}
}

func TestSQLitePolicyCancellationDuringConnectionWait(t *testing.T) {
	s, _ := newSQLite(t)
	policies, err := s.ListStoragePolicies()
	if err != nil {
		t.Fatal(err)
	}
	held, err := s.db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()
	waits := s.db.Stats().WaitCount
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- s.ApplyStoragePoliciesContext(ctx, policies) }()
	deadline := time.Now().Add(time.Second)
	for s.db.Stats().WaitCount == waits {
		if time.Now().After(deadline) {
			held.Close()
			cancel()
			<-done
			t.Fatal("policy update did not wait for the held connection")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation error=%v", err)
		}
	case <-time.After(500 * time.Millisecond):
		held.Close()
		<-done
		t.Fatal("cancelled policy update stayed blocked on connection")
	}
	if err := held.Close(); err != nil {
		t.Fatal(err)
	}
	probeCtx, probeCancel := context.WithTimeout(context.Background(), time.Second)
	defer probeCancel()
	probe, err := s.db.Conn(probeCtx)
	if err != nil {
		t.Fatalf("cancelled policy operation leaked sole connection: %v", err)
	}
	probe.Close()
}
