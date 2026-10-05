//go:build !lite

package store

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"
	"time"
)

// The fixture ends at a UTC month boundary and uses the retained resolution
// for every part of its 365 days. Sparse accounts observe every 31st bucket;
// dense accounts observe every bucket. Creation is outside measured reads.
func trafficReportFixture(b *testing.B, accounts int, dense bool) (*SQLite, int64, string) {
	b.Helper()
	path := filepath.Join(b.TempDir(), "traffic.db")
	s, err := NewSQLite(path)
	if err != nil {
		b.Fatal(err)
	}
	asOf := time.Date(2026, 9, 30, 23, 59, 30, 0, time.UTC).Unix()
	from := asOf - 365*86400
	month := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC).Unix()
	tiers := []TrafficTierPolicy{
		{Tier: MetricTierQuarter, WidthSecs: 900, RetentionSecs: 86400},
		{Tier: MetricTierHour, WidthSecs: 3600, RetentionSecs: 30 * 86400},
		{Tier: MetricTierDay, WidthSecs: 86400, RetentionSecs: 365 * 86400},
	}
	windows, _, err := PlanTrafficWindows(from, asOf, asOf, tiers)
	if err != nil {
		b.Fatal(err)
	}
	tx, err := s.db.Begin()
	if err != nil {
		b.Fatal(err)
	}
	defer tx.Rollback()
	users, err := tx.Prepare(`INSERT INTO user_traffic_users(id,username,total_bytes,since_ts,updated_ts,month_key,month_bytes,continuity) VALUES(?,?,0,?,?,202609,0,'normal')`)
	if err != nil {
		b.Fatal(err)
	}
	defer users.Close()
	buckets, err := tx.Prepare(`INSERT INTO user_traffic_buckets(user_id,tier,ts,bytes) VALUES(?,?,?,?)`)
	if err != nil {
		b.Fatal(err)
	}
	defer buckets.Close()
	update, err := tx.Prepare(`UPDATE user_traffic_users SET total_bytes=?,month_bytes=? WHERE id=?`)
	if err != nil {
		b.Fatal(err)
	}
	defer update.Close()
	rows := 0
	for id := 1; id <= accounts; id++ {
		if _, err := users.Exec(id, fmt.Sprintf("bench-%04d", id), from, asOf); err != nil {
			b.Fatal(err)
		}
		var total, monthly int64
		ordinal := 0
		for _, window := range windows {
			width, tier := int64(86400), 2
			if window.Tier == MetricTierQuarter {
				width, tier = 900, 0
			}
			if window.Tier == MetricTierHour {
				width, tier = 3600, 1
			}
			for ts := window.From; ts < window.To; ts += width {
				ordinal++
				if !dense && (ordinal+id)%31 != 0 {
					continue
				}
				bytes := int64((id*17+ordinal)%97+1) * 1024
				if _, err := buckets.Exec(id, tier, ts, bytes); err != nil {
					b.Fatal(err)
				}
				total += bytes
				if ts >= month {
					monthly += bytes
				}
				rows++
			}
		}
		if _, err := update.Exec(total, monthly, id); err != nil {
			b.Fatal(err)
		}
	}
	if _, err := tx.Exec(`INSERT INTO user_traffic_collector(singleton,last_success_ts,source_started_at,source_state,continuity) VALUES(1,?,?,'collecting','normal')`, asOf, from); err != nil {
		b.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		b.Fatal(err)
	}
	var mode string
	var synchronous int
	if err := s.db.QueryRow(`PRAGMA journal_mode`).Scan(&mode); err != nil {
		b.Fatal(err)
	}
	if err := s.db.QueryRow(`PRAGMA synchronous`).Scan(&synchronous); err != nil {
		b.Fatal(err)
	}
	if mode != "wal" || synchronous != 2 {
		b.Fatalf("durability: journal=%s synchronous=%d", mode, synchronous)
	}
	fmt.Fprintf(os.Stdout, "FIXTURE accounts=%d dense=%v days=365 buckets=%d as_of=%d journal=%s synchronous=%d\n", accounts, dense, rows, asOf, mode, synchronous)
	return s, asOf, path
}

func trafficMonthlyReportRead(s *SQLite, asOf int64, reuse bool) error {
	raw, err := s.BeginTrafficRead(context.Background())
	if err != nil {
		return err
	}
	defer raw.Close()
	r := raw.(*sqlTrafficReadSnapshot)
	r.asOf = asOf
	from := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC).Unix()
	if _, _, _, err := r.Aggregate(from, asOf); err != nil {
		return err
	}
	summaries, err := r.Summaries()
	if err != nil {
		return err
	}
	var total int64
	for _, summary := range summaries {
		if summary.CurrentMonthBytes > math.MaxInt64-total {
			return fmt.Errorf("monthly total overflow")
		}
		total += summary.CurrentMonthBytes
	}
	if _, _, _, err := r.Aggregate(from-(asOf-from), from); err != nil {
		return err
	}
	if _, _, err := r.Ranking(from, asOf, false, 5, nil); err != nil {
		return err
	}
	if _, err := r.CollectorState(); err != nil {
		return err
	}
	if !reuse {
		if _, err := r.Summaries(); err != nil {
			return err
		}
	}
	return r.Close()
}

func trafficReportQueryPlans(b *testing.B, s *SQLite, asOf int64) {
	b.Helper()
	raw, err := s.BeginTrafficRead(context.Background())
	if err != nil {
		b.Fatal(err)
	}
	defer raw.Close()
	r := raw.(*sqlTrafficReadSnapshot)
	r.asOf = asOf
	from := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC).Unix()
	windows, _, err := PlanTrafficWindows(from, asOf, asOf, r.tiers)
	if err != nil {
		b.Fatal(err)
	}
	predicate, args := trafficSQLPredicate(windows)
	aggregate, aggregateArgs := trafficAggregateSQL(windows)
	queries := []struct {
		name, sql string
		args      []any
	}{
		{"aggregate", aggregate, aggregateArgs},
		{"ranking", `SELECT users.username,sum(buckets.bytes) FROM user_traffic_users AS users CROSS JOIN user_traffic_buckets AS buckets ON users.id=buckets.user_id WHERE ` + predicate + ` AND (? OR users.deleted_ts IS NULL) GROUP BY users.id ORDER BY sum(buckets.bytes) DESC,users.username ASC LIMIT ?`, append(slices.Clone(args), false, 5)},
	}
	for _, query := range queries {
		rows, err := r.tx.Query(`EXPLAIN QUERY PLAN `+query.sql, query.args...)
		if err != nil {
			b.Fatal(err)
		}
		for rows.Next() {
			var id, parent, unused int
			var detail string
			if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
				b.Fatal(err)
			}
			fmt.Fprintf(os.Stdout, "QUERY_PLAN %s %s\n", query.name, detail)
		}
		if err := rows.Err(); err != nil {
			b.Fatal(err)
		}
		rows.Close()
	}
}

// BenchmarkTrafficMonthlyReport mirrors the report's snapshot read sequence.
// Run with -benchtime=20x for the audited 5 warmups and 20 samples. A reopened
// pool has a cold SQLite page cache; it does not imply a cold OS disk cache.
func BenchmarkTrafficMonthlyReport(b *testing.B) {
	reuse := os.Getenv("TRAFFIC_REPORT_REUSE") == "1"
	for _, accounts := range []int{100, 1000} {
		for _, dense := range []bool{false, true} {
			density := "sparse"
			if dense {
				density = "dense"
			}
			b.Run(fmt.Sprintf("%d/%s", accounts, density), func(b *testing.B) {
				s, asOf, path := trafficReportFixture(b, accounts, dense)
				defer func() { _ = s.Close() }()
				trafficReportQueryPlans(b, s, asOf)
				for _, cold := range []bool{false, true} {
					mode := "warm"
					if cold {
						mode = "reopened"
					}
					b.Run(mode, func(b *testing.B) {
						for i := 0; i < 5; i++ {
							if err := trafficMonthlyReportRead(s, asOf, reuse); err != nil {
								b.Fatal(err)
							}
						}
						b.ReportAllocs()
						samples := make([]float64, 0, b.N)
						b.ResetTimer()
						for i := 0; i < b.N; i++ {
							if cold {
								b.StopTimer()
								if err := s.Close(); err != nil {
									b.Fatal(err)
								}
								var err error
								s, err = NewSQLite(path)
								if err != nil {
									b.Fatal(err)
								}
								b.StartTimer()
							}
							start := time.Now()
							if err := trafficMonthlyReportRead(s, asOf, reuse); err != nil {
								b.Fatal(err)
							}
							samples = append(samples, float64(time.Since(start).Nanoseconds())/1e6)
						}
						b.StopTimer()
						b.Logf("RAW_SAMPLES_MS %v reuse=%v CPUs=%d GOMAXPROCS=%d", samples, reuse, runtime.NumCPU(), runtime.GOMAXPROCS(0))
						slices.Sort(samples)
						b.ReportMetric(samples[(len(samples)-1)/2], "p50-ms")
						b.ReportMetric(samples[(len(samples)*95+99)/100-1], "p95-ms")
					})
				}
			})
		}
	}
}
