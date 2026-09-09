package userprojection

import (
	"bytes"
	"encoding/json"
	"math"
	"reflect"
	"testing"

	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

func uint64Pointer(value uint64) *uint64 {
	return &value
}

func TestBuildPreservesUserInfoAndMapsSummaries(t *testing.T) {
	user := telemt.UserInfo{
		Username:           "alice",
		Enabled:            true,
		InRuntime:          true,
		UserAdTag:          "000102030405060708090a0b0c0d0e0f",
		MaxTCPConns:        uint64Pointer(11),
		ExpirationRFC3339:  "2030-01-02T03:04:05Z",
		DataQuotaBytes:     uint64Pointer(12),
		RateLimitUpBps:     uint64Pointer(13),
		RateLimitDownBps:   uint64Pointer(14),
		MaxUniqueIPs:       uint64Pointer(15),
		CurrentConnections: 16,
		ActiveUniqueIPs:    17,
		ActiveIPList:       []string{"192.0.2.1"},
		RecentUniqueIPs:    18,
		RecentIPList:       []string{"2001:db8::1"},
		TotalOctets:        19,
		Links: telemt.UserLinks{
			Classic:    []string{"classic"},
			Secure:     []string{"secure"},
			TLS:        []string{"tls"},
			TLSDomains: []telemt.TLSDomainLink{{Domain: "example.com", Link: "tls-domain"}},
		},
	}
	traffic := map[string]store.UserTrafficSummary{
		"alice": {
			Username:               "alice",
			ObservedTotalBytes:     21,
			CurrentMonthBytes:      22,
			MonthKey:               202609,
			ObservedSinceEpochSecs: 23,
			LastActivityEpochSecs:  24,
			DeletedEpochSecs:       25,
			Continuity:             store.UserTrafficPartial,
		},
	}
	ips := map[string]store.UserIPSummary{
		"alice": {Unique: 26, From: 27, Through: 28, Limited: true, Gap: true},
	}

	got := Build(user, traffic, ips)

	if !reflect.DeepEqual(got.UserInfo, user) {
		t.Fatalf("UserInfo = %#v, want %#v", got.UserInfo, user)
	}
	wantTraffic := &Traffic{
		ObservedTotalBytes:     21,
		CurrentMonthBytes:      22,
		MonthKey:               202609,
		ObservedSinceEpochSecs: 23,
		LastActivityEpochSecs:  24,
		Continuity:             store.UserTrafficPartial,
	}
	if !reflect.DeepEqual(got.Traffic, wantTraffic) {
		t.Errorf("Traffic = %#v, want %#v", got.Traffic, wantTraffic)
	}
	wantIP := &store.UserIPSummary{Unique: 26, From: 27, Through: 28, Limited: true, Gap: true}
	if !reflect.DeepEqual(got.IPHistory, wantIP) {
		t.Errorf("IPHistory = %#v, want %#v", got.IPHistory, wantIP)
	}
	payload, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(payload, &fields); err != nil {
		t.Fatalf("Unmarshal fields: %v", err)
	}
	wantFields := []string{
		"username", "enabled", "in_runtime", "user_ad_tag", "max_tcp_conns",
		"expiration_rfc3339", "data_quota_bytes", "rate_limit_up_bps",
		"rate_limit_down_bps", "max_unique_ips", "current_connections",
		"active_unique_ips", "active_unique_ips_list", "recent_unique_ips",
		"recent_unique_ips_list", "total_octets", "links", "traffic", "ip_history",
	}
	if len(fields) != len(wantFields) {
		t.Fatalf("JSON fields = %v, want exactly %v", fields, wantFields)
	}
	for _, name := range wantFields {
		if _, ok := fields[name]; !ok {
			t.Errorf("JSON field %q missing from %s", name, payload)
		}
	}
	if traffic["alice"].DeletedEpochSecs != 25 || ips["alice"].Unique != 26 {
		t.Fatalf("Build mutated source summaries: traffic=%#v ips=%#v", traffic, ips)
	}
}

func TestBuildOmitsAbsentSummariesAndPreservesEmptyArrays(t *testing.T) {
	user := telemt.UserInfo{
		Username:     "empty",
		ActiveIPList: []string{},
		RecentIPList: []string{},
		Links: telemt.UserLinks{
			Classic:    []string{},
			Secure:     []string{},
			TLS:        []string{},
			TLSDomains: []telemt.TLSDomainLink{},
		},
	}

	got := Build(user, map[string]store.UserTrafficSummary{}, nil)
	payload, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	for _, forbidden := range [][]byte{
		[]byte(`"traffic"`),
		[]byte(`"ip_history"`),
		[]byte(`"active_unique_ips_list":null`),
		[]byte(`"recent_unique_ips_list":null`),
		[]byte(`"classic":null`),
		[]byte(`"secure":null`),
		[]byte(`"tls":null`),
		[]byte(`"tls_domains":null`),
	} {
		if bytes.Contains(payload, forbidden) {
			t.Errorf("payload contains %s: %s", forbidden, payload)
		}
	}
}

func TestBuildMarshalsUint64CountersWithoutPrecisionLoss(t *testing.T) {
	got := Build(telemt.UserInfo{
		Username:           "large",
		MaxUniqueIPs:       uint64Pointer(9_007_199_254_740_991),
		MaxTCPConns:        uint64Pointer(9_007_199_254_740_992),
		DataQuotaBytes:     uint64Pointer(9_007_199_254_740_993),
		CurrentConnections: math.MaxUint64,
		ActiveUniqueIPs:    9_007_199_254_740_992,
		RecentUniqueIPs:    9_007_199_254_740_993,
		TotalOctets:        math.MaxUint64,
	}, nil, nil)
	payload, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(payload, &fields); err != nil {
		t.Fatalf("Unmarshal raw fields: %v", err)
	}
	want := map[string]string{
		"max_unique_ips":      "9007199254740991",
		"max_tcp_conns":       "9007199254740992",
		"data_quota_bytes":    "9007199254740993",
		"current_connections": "18446744073709551615",
		"active_unique_ips":   "9007199254740992",
		"recent_unique_ips":   "9007199254740993",
		"total_octets":        "18446744073709551615",
	}
	for name, value := range want {
		if string(fields[name]) != value {
			t.Errorf("%s token = %s, want %s (payload %s)", name, fields[name], value, payload)
		}
	}
}
