package hub

import (
	"github.com/amirotin/telemt_panel/internal/store"
	"sort"
	"strings"
)

// UserIPLiveSnapshot owns only active records and the quality of that observation.
type UserIPLiveSnapshot struct {
	Records            []store.UserIPRecord
	Source             UserIPSourceStatus
	Epoch              uint64
	Partial, Truncated bool
	InvalidUsers       int
}

// UserIPSnapshot copies the live overlay; no enrichment runs under the collector lock.
func (h *Hub) UserIPSnapshot(now int64) UserIPLiveSnapshot {
	stored := h.ips.snapshot.Load()
	if stored == nil {
		return UserIPLiveSnapshot{Records: []store.UserIPRecord{}, Source: UserIPSourceStatus{State: "unavailable"}}
	}
	out := *stored
	out.Source = liveSnapshotStatus(stored, now)
	records := stored.Records
	if len(records) > store.UserIPMemoryLimit {
		records = records[:store.UserIPMemoryLimit]
		out.Truncated, out.Partial = true, true
	}
	out.Records = append([]store.UserIPRecord{}, records...)
	return out
}

func liveSnapshotStatus(stored *UserIPLiveSnapshot, now int64) UserIPSourceStatus {
	if stored == nil {
		return UserIPSourceStatus{State: "unavailable"}
	}
	status := stored.Source
	status.AgeSeconds = nil
	if status.LastSuccess > 0 {
		age := now - status.LastSuccess
		if age >= 0 {
			status.AgeSeconds = &age
		}
		if age < 0 || age > 30 {
			status.State = "stale"
		}
	}
	if status.RecentWindow != nil {
		window := *status.RecentWindow
		status.RecentWindow = &window
	}
	return status
}

// UserIPSnapshotStatus reads freshness without copying all active memberships.
func (h *Hub) UserIPSnapshotStatus(now int64) UserIPSourceStatus {
	return liveSnapshotStatus(h.ips.snapshot.Load(), now)
}

func (h *Hub) publishUserIPSnapshotLocked() {
	copy := h.copyUserIPSnapshotLocked(h.now().Unix())
	h.ips.snapshot.Store(&copy)
}

func (h *Hub) publishUserIPSnapshotStatusLocked() {
	next := UserIPLiveSnapshot{Records: []store.UserIPRecord{}, Epoch: h.ips.generation}
	if stored := h.ips.snapshot.Load(); stored != nil {
		// Observations own this immutable backing array; status updates reuse it.
		next = *stored
	}
	next.Source = h.userIPSnapshotStatusLocked(h.now().Unix())
	h.ips.snapshot.Store(&next)
}

func (h *Hub) userIPSnapshotStatusLocked(now int64) UserIPSourceStatus {
	c := &h.ips
	status := UserIPSourceStatus{State: "unavailable", Limited: c.livePartial, Gap: c.liveInvalidUsers > 0, Pending: len(c.pending) > 0 || c.retry != nil}
	if c.live == nil || !c.liveKnown {
		return status
	}
	status.LastSuccess = c.through
	age := now - c.through
	if age >= 0 {
		status.AgeSeconds = &age
	}
	status.State = "collecting"
	if c.failed || age < 0 || age > 30 {
		status.State = "stale"
	}
	return status
}

func (h *Hub) copyUserIPSnapshotLocked(now int64) UserIPLiveSnapshot {
	c := &h.ips
	out := UserIPLiveSnapshot{Records: []store.UserIPRecord{}, Source: h.userIPSnapshotStatusLocked(now), Epoch: c.generation, Partial: c.livePartial, Truncated: c.liveTruncated, InvalidUsers: c.liveInvalidUsers}
	if c.live == nil || !c.liveKnown {
		return out
	}
	count := 0
	for _, live := range c.live {
		count += len(live.active)
	}
	out.Records = make([]store.UserIPRecord, 0, count)
	for username, live := range c.live {
		for ip := range live.active {
			family := 4
			if strings.Contains(ip, ":") {
				family = 6
			}
			out.Records = append(out.Records, store.UserIPRecord{Username: username, IP: ip, Family: family, First: live.at, Last: live.at, LastActive: live.at, Observations: 1, Source: 1})
		}
	}
	sort.Slice(out.Records, func(i, j int) bool {
		a, b := out.Records[i], out.Records[j]
		if a.Username != b.Username {
			return a.Username < b.Username
		}
		return a.IP < b.IP
	})
	return out
}

// UserIPResetEpoch lets a reader reject work that started before a collector reset.
func (h *Hub) UserIPResetEpoch() uint64 {
	if snapshot := h.ips.snapshot.Load(); snapshot != nil {
		return snapshot.Epoch
	}
	return 0
}
