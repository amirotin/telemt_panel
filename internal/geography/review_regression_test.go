package geography

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/store"
)

type unreadableLocationStore struct{ SettingsStore }

func (unreadableLocationStore) GetSetting(string) (string, bool, error) {
	return "", false, errors.New("read failed")
}

func TestSettingsRecoveryKeepsGeographyAvailable(t *testing.T) {
	for _, scenario := range []string{"invalid-json", "invalid-mode", "unknown-private-field", "read-error"} {
		t.Run(scenario, func(t *testing.T) {
			state, _ := store.NewMemoryHistory()
			defer state.Close()
			var settings SettingsStore = state
			switch scenario {
			case "invalid-json":
				_ = state.SetSetting(serverLocationKey, `{"mode": "203.0.113.123"`)
			case "invalid-mode":
				_ = state.SetSetting(serverLocationKey, `{"mode":"bogus","public_ip":"203.0.113.123"}`)
			case "unknown-private-field":
				_ = state.SetSetting(serverLocationKey, `{"mode":"hidden","203.0.113.123":"secret"}`)
			case "read-error":
				settings = unreadableLocationStore{state}
			}
			var output bytes.Buffer
			previous := slog.Default()
			slog.SetDefault(slog.New(slog.NewTextHandler(&output, nil)))
			defer slog.SetDefault(previous)
			s := NewService(Dependencies{State: settings})
			defer s.Close()
			got, err := s.Settings(context.Background())
			if err != nil || got.ServerLocation.Mode != "hidden" {
				t.Fatalf("unrecoverable settings: %+v, %v", got, err)
			}
			if _, err := s.Overview(context.Background(), OverviewQuery{}); err != nil {
				t.Fatalf("marker corruption broke geography: %v", err)
			}
			if _, err := s.PutSettings(context.Background(), ServerLocationConfig{Mode: "hidden", Label: "repaired"}); err != nil {
				t.Fatal(err)
			}
			got, err = s.Settings(context.Background())
			if err != nil || got.ServerLocation.Label != "repaired" {
				t.Fatalf("repair not published: %+v, %v", got, err)
			}
			if !strings.Contains(output.String(), "stored server location ignored") || strings.Contains(output.String(), "203.0.113.123") {
				t.Fatalf("missing or unsafe diagnostic: %s", output.String())
			}
		})
	}
}

func TestServiceUsesInjectedBuildDeadline(t *testing.T) {
	_, clock, resolver, live, state := serviceFixture(t)
	resolver.hook = func(ctx context.Context, _ []string, _ uint64) error {
		<-ctx.Done()
		return ctx.Err()
	}
	s := NewService(Dependencies{Live: live, GeoIP: resolver, State: state, Now: clock.now, BuildTimeout: 25 * time.Millisecond, RequestTimeout: time.Second})
	defer s.Close()
	done := make(chan error, 1)
	go func() { _, err := s.Overview(context.Background(), OverviewQuery{}); done <- err }()
	select {
	case err := <-done:
		if !errors.Is(err, ErrTimeout) {
			t.Fatalf("deadline error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("injected build deadline was ignored")
	}
}

type statusOnlyLive struct{ testLive }

func (*statusOnlyLive) UserIPSnapshot(int64) hub.UserIPLiveSnapshot {
	panic("history projections must not copy active memberships")
}

func TestHistoryProjectionReadsOnlyLiveStatus(t *testing.T) {
	state, _ := store.NewMemoryHistory()
	defer state.Close()
	live := &statusOnlyLive{}
	live.snapshot.Source.Pending = true
	s := NewService(Dependencies{Live: live, History: state, State: state})
	defer s.Close()
	view, err := s.Overview(context.Background(), OverviewQuery{Range: "7d", Family: "all"})
	if err != nil || !view.Source.Pending {
		t.Fatalf("history pending metadata missing: %v %+v", err, view.Source)
	}
}

type mixedHistory struct{ HistorySource }

func (h mixedHistory) ReadUserIPSnapshot(ctx context.Context, from, now int64) (store.UserIPReadSnapshot, error) {
	snapshot, err := h.HistorySource.ReadUserIPSnapshot(ctx, from, now)
	snapshot.Partial = true
	return snapshot, err
}

func TestHistoryProjectionDisclosesMixedChunkVersion(t *testing.T) {
	_, clock, _, _, state := serviceFixture(t)
	now := clock.now().Unix()
	if err := state.ApplyUserIPBatch(store.UserIPBatch{ID: "mixed", Through: now, Records: []store.UserIPRecord{{Username: "alice", IP: "1.1.1.1", Family: 4, First: now, Last: now, Observations: 1, Source: 1}}}); err != nil {
		t.Fatal(err)
	}
	s := NewService(Dependencies{History: mixedHistory{state}, State: state, Now: clock.now})
	defer s.Close()
	view, err := s.Overview(context.Background(), OverviewQuery{Range: "7d", Family: "all"})
	if err != nil || view.Totals.UniqueIPs != 1 || !view.Source.Partial || view.Source.InputTruncated || view.Source.CollectionGap || view.State != "partial" {
		t.Fatalf("mixed read not distinguished from truncation/gap: %+v, %v", view, err)
	}
}
