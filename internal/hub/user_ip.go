package hub

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"sync"

	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

type ipObserverKey struct{}
type observedIPKey struct{ user, ip string }
type userIPLiveState struct {
	at     int64
	valid  bool
	active map[string]bool
}
type userIPCollector struct {
	mu            sync.Mutex
	generation    uint64
	pending       map[observedIPKey]store.UserIPRecord
	retry         *store.UserIPBatch
	live          map[string]userIPLiveState
	through       int64
	flushed       int64
	limited       bool
	gap           bool
	failed        bool
	window        *uint64
	windowChecked int64
	lastPrune     int64
}

func (h *Hub) pollPeriodic(t *topicState) bool {
	if t.name != "users" || h.st == nil {
		return h.poll(t)
	}
	h.ips.mu.Lock()
	generation := h.ips.generation
	now := h.now().Unix()
	prune := h.ips.lastPrune == 0 || now-h.ips.lastPrune >= 3600
	h.ips.mu.Unlock()
	// Housekeeping must run even when the upcoming Telemt request fails.
	if prune {
		if err := h.st.PruneUserIPHistory(now); err != nil {
			slog.Warn("hub: IP history cleanup failed")
		} else {
			h.ips.mu.Lock()
			h.ips.lastPrune = now
			h.ips.mu.Unlock()
		}
	}
	ctx := context.WithValue(h.ctx, ipObserverKey{}, func(users []telemt.UserInfo) { h.observeUserIPs(users, generation) })
	ok := h.pollWithContext(ctx, t)
	h.ips.mu.Lock()
	if !ok {
		h.ips.failed = true
		h.ips.gap = true
		if h.now().Unix()-h.ips.flushed >= 60 {
			if err := h.flushUserIPsLocked(); err != nil {
				slog.Warn("hub: pending IP history batch not saved")
			}
		}
	}
	refresh := h.now().Unix()-h.ips.windowChecked >= 60
	if refresh {
		h.ips.windowChecked = h.now().Unix()
	}
	h.ips.mu.Unlock()
	if refresh && h.tc != nil {
		limits, err := h.tc.EffectiveLimits(h.ctx)
		h.ips.mu.Lock()
		h.ips.window = nil
		if err == nil && limits.UserIPPolicy.WindowSecs > 0 {
			v := limits.UserIPPolicy.WindowSecs
			h.ips.window = &v
		}
		h.ips.mu.Unlock()
	}
	return ok
}

// observeUserIPs is called only by the periodic users fetch, before optional
// quota enrichment. REST snapshots, Poke and traffic sampling never count.
func (h *Hub) observeUserIPs(users []telemt.UserInfo, generation uint64) {
	h.ips.mu.Lock()
	defer h.ips.mu.Unlock()
	c := &h.ips
	if generation != c.generation {
		return
	}
	now := h.now().Unix()
	if now <= c.through {
		return
	}
	if c.through == 0 {
		previous, err := h.st.UserIPCollectionState()
		if err != nil {
			c.gap = true
			return
		}
		if now <= previous.Through {
			return
		}
		c.gap = c.gap || previous.Through > 0
	}
	if c.through > 0 && now-c.through > 30 {
		c.gap = true
	}
	c.through = now
	c.failed = false
	if c.pending == nil {
		c.pending = make(map[observedIPKey]store.UserIPRecord)
	}
	c.live = make(map[string]userIPLiveState)
	retryKeys := make(map[observedIPKey]bool)
	if c.retry != nil {
		for _, r := range c.retry.Records {
			retryKeys[observedIPKey{r.Username, r.IP}] = true
		}
	}
	// Bound both current/retry buffers and ephemeral active overlays.
	buffered := len(c.pending) + len(retryKeys)
	liveCount := 0
	for _, user := range users {
		if user.Username == "" || len(user.Username) > 256 {
			c.gap = true
			continue
		}
		if len(c.live) >= store.UserIPMemoryLimit {
			c.limited = true
			break
		}
		live := userIPLiveState{at: now, valid: user.ActiveIPList != nil, active: make(map[string]bool)}
		union := make(map[string]int)
		for index, list := range [][]string{user.ActiveIPList, user.RecentIPList} {
			if list == nil {
				c.gap = true
			}
			for _, raw := range list {
				ip, _, err := store.NormalizeUserIP(raw)
				if err != nil {
					c.gap = true
					if index == 0 {
						live.valid = false
					}
					continue
				}
				if _, exists := union[ip]; !exists && len(union) >= store.UserIPPerUserLimit {
					c.limited = true
					if index == 0 {
						live.valid = false
					}
					continue
				}
				union[ip] |= 1 << index
				if index == 0 {
					if liveCount >= store.UserIPMemoryLimit {
						c.limited = true
						live.valid = false
					} else if !live.active[ip] {
						live.active[ip] = true
						liveCount++
					}
				}
			}
		}
		c.live[user.Username] = live
		for ip, source := range union {
			key := observedIPKey{user.Username, ip}
			_, exists := c.pending[key]
			if !exists && buffered >= store.UserIPBatchLimit {
				c.limited = true
				continue
			}
			_, family, _ := store.NormalizeUserIP(ip)
			r := store.UserIPRecord{Username: user.Username, IP: ip, Family: family, First: now, Last: now, Observations: 1, Source: source}
			if source&1 != 0 {
				r.LastActive = now
			}
			c.pending[key] = store.MergeUserIPRecord(c.pending[key], r)
			if !exists {
				buffered++
			}
		}
	}
	if !h.st.Info().Durable || c.flushed == 0 || now-c.flushed >= 60 {
		if err := h.flushUserIPsLocked(); err != nil {
			slog.Warn("hub: IP history batch not saved")
		}
	}
}

func (h *Hub) flushUserIPsLocked() error {
	c := &h.ips
	if c.retry != nil {
		if err := h.st.ApplyUserIPBatch(*c.retry); err != nil {
			return err
		}
		c.flushed = c.retry.Through
		c.retry = nil
	}
	if c.through <= c.flushed {
		return nil
	}
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return err
	}
	b := store.UserIPBatch{ID: hex.EncodeToString(id[:]), Through: c.through, Limited: c.limited, Gap: c.gap, Records: make([]store.UserIPRecord, 0, len(c.pending))}
	for _, r := range c.pending {
		b.Records = append(b.Records, r)
	}
	c.pending = make(map[observedIPKey]store.UserIPRecord)
	c.retry = &b
	if err := h.st.ApplyUserIPBatch(b); err != nil {
		return err
	}
	c.flushed = b.Through
	c.retry = nil
	return nil
}

func (h *Hub) flushUserIPs() {
	if h.st == nil {
		return
	}
	h.ips.mu.Lock()
	defer h.ips.mu.Unlock()
	if err := h.flushUserIPsLocked(); err != nil {
		slog.Warn("hub: final IP history batch not saved")
	}
}

// Reset serializes with pending writes. Generation invalidates any fetch that
// started before the reset; a subsequent periodic observation starts anew.
func (h *Hub) ResetUserIPHistory(username string) error {
	h.ips.mu.Lock()
	defer h.ips.mu.Unlock()
	if err := h.flushUserIPsLocked(); err != nil {
		return err
	}
	if err := h.st.ResetUserIPHistory(username); err != nil {
		return err
	}
	h.ips.generation++
	if username == "" {
		h.ips.live = nil
		h.ips.limited = false
		h.ips.gap = false
	} else {
		delete(h.ips.live, username)
	}
	return nil
}

func (h *Hub) UserIPLive(username, ip string) *bool {
	h.ips.mu.Lock()
	defer h.ips.mu.Unlock()
	live, ok := h.ips.live[username]
	age := h.now().Unix() - live.at
	if !ok || !live.valid || h.ips.failed || age < 0 || age > 30 {
		return nil
	}
	value := live.active[ip]
	return &value
}

// UserIPActiveCount covers the entire live user snapshot, not a history page.
func (h *Hub) UserIPActiveCount(username string) *int {
	h.ips.mu.Lock()
	defer h.ips.mu.Unlock()
	live, ok := h.ips.live[username]
	age := h.now().Unix() - live.at
	if !ok || !live.valid || h.ips.failed || age < 0 || age > 30 {
		return nil
	}
	count := len(live.active)
	return &count
}

type UserIPSourceStatus struct {
	State        string  `json:"state"`
	LastSuccess  int64   `json:"last_success_at"`
	AgeSeconds   *int64  `json:"age_secs"`
	RecentWindow *uint64 `json:"recent_window_secs"`
	Pending      bool    `json:"pending"`
	Limited      bool    `json:"history_limited"`
	Gap          bool    `json:"collection_gap"`
}

func (h *Hub) UserIPSourceStatus() UserIPSourceStatus {
	h.ips.mu.Lock()
	defer h.ips.mu.Unlock()
	c := &h.ips
	state := "collecting"
	age := h.now().Unix() - c.through
	var ageSeconds *int64
	if c.through > 0 && age >= 0 {
		ageSeconds = &age
	}
	if c.failed || c.through == 0 || age < 0 || age > 30 {
		state = "unavailable"
	}
	var window *uint64
	if c.window != nil {
		v := *c.window
		window = &v
	}
	return UserIPSourceStatus{State: state, LastSuccess: c.through, AgeSeconds: ageSeconds, RecentWindow: window, Pending: len(c.pending) > 0 || c.retry != nil, Limited: c.limited, Gap: c.gap}
}
