package geoip

import (
	"context"
	"errors"
	"net/netip"
	"time"
)

// ErrGenerationChanged rejects a read against a replaced or closed bundle.
var ErrGenerationChanged = errors.New("geoip: database generation changed")

// IsNonPublic classifies normalized local and special network addresses.
func IsNonPublic(addr netip.Addr) bool { return isNonPublic(addr) }

// Generation identifies the active bundle lifetime, including disable and Close.
func (m *Manager) Generation() uint64 {
	return m.generation.Load()
}

// LookupBatch reads at most 512 addresses from one generation without using the page LRU.
func (m *Manager) LookupBatch(ctx context.Context, ips []string, expected uint64) (Status, []*Result, error) {
	if len(ips) > 512 {
		return Status{}, nil, errors.New("geoip: batch exceeds 512 addresses")
	}
	if err := ctx.Err(); err != nil {
		return Status{}, nil, err
	}
	if !m.mu.TryRLock() {
		delay := time.Millisecond
		timer := time.NewTimer(delay)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return Status{}, nil, ctx.Err()
			case <-timer.C:
			}
			if m.mu.TryRLock() {
				break
			}
			delay = min(delay*2, 50*time.Millisecond)
			timer.Reset(delay)
		}
	}
	defer m.mu.RUnlock()
	if m.closed || m.generation.Load() != expected {
		return Status{}, nil, ErrGenerationChanged
	}
	status := m.statusLocked()
	results := make([]*Result, len(ips))
	for i, raw := range ips {
		if err := ctx.Err(); err != nil {
			return Status{}, nil, err
		}
		addr, err := netip.ParseAddr(raw)
		if err != nil {
			continue
		}
		addr = addr.Unmap()
		if IsNonPublic(addr) {
			results[i] = &Result{State: ResultPrivate}
			continue
		}
		if m.active == nil {
			continue
		}
		result, err := m.active.lookup(addr)
		if err != nil {
			return Status{}, nil, err
		}
		results[i] = cloneResult(result)
	}
	if err := ctx.Err(); err != nil {
		return Status{}, nil, err
	}
	return status, results, nil
}
