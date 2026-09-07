//go:build !lite

package hub

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

// Opt-in accelerated day: production cadence and SQLite writes, no wall-clock sleeps.
func TestUserIPDayScale(t *testing.T) {
	if os.Getenv("RUN_IP_HISTORY_SOAK") != "1" {
		t.Skip("set RUN_IP_HISTORY_SOAK=1 for the accelerated day")
	}
	s, err := store.NewSQLite(filepath.Join(t.TempDir(), "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Now()
	h := &Hub{st: s, now: func() time.Time { return now }}
	users := make([]telemt.UserInfo, 2000)
	for i := range users {
		users[i] = telemt.UserInfo{Username: fmt.Sprintf("user%04d", i), ActiveIPList: []string{fmt.Sprintf("10.%d.%d.1", i/256, i%256)}, RecentIPList: []string{}}
	}
	h.observeUserIPs(users, 0)
	runtime.GC()
	baseRSS := ipTestRSS()
	peakRSS := baseRSS
	times := make([]time.Duration, 0, 8640)
	started := time.Now()
	for tick := 1; tick <= 8640; tick++ {
		now = now.Add(10 * time.Second)
		if tick%360 == 1 {
			for i := range users {
				users[i].RecentIPList = []string{fmt.Sprintf("2001:db8:%x::%x", i, tick/360+1)}
			}
		}
		begin := time.Now()
		h.observeUserIPs(users, 0)
		times = append(times, time.Since(begin))
		if tick%360 == 0 {
			peakRSS = max(peakRSS, ipTestRSS())
		}
	}
	h.flushUserIPs()
	peakRSS = max(peakRSS, ipTestRSS())
	sort.Slice(times, func(i, j int) bool { return times[i] < times[j] })
	page, err := s.UserIPHistory(store.UserIPQuery{Username: "user0000", Now: now.Unix(), Limit: 50})
	if err != nil || page.Total != 25 {
		t.Fatalf("day history: %+v %v", page, err)
	}
	for _, r := range page.Items {
		if r.Family == 4 && r.Observations != 8641 {
			t.Fatal("missed or duplicate observations", r.Observations)
		}
	}
	t.Logf("2000 users / simulated 24h / 8641 polls: elapsed=%s ingest p95=%s peak RSS delta=%d KiB records/user=%d DB bytes=%d", time.Since(started), times[len(times)*95/100], peakRSS-baseRSS, page.Total, s.Info().SizeHint)
}

func ipTestRSS() int64 {
	data, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) > 1 && fields[0] == "VmRSS:" {
			n, _ := strconv.ParseInt(fields[1], 10, 64)
			return n
		}
	}
	return 0
}
