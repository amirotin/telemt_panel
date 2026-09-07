package store

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestUserIPMemory(t *testing.T) {
	m, err := NewMemoryHistory()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	runUserIPContract(t, m)
}

func runUserIPContract(t *testing.T, st UserIPStore) {
	const now int64 = 1800000000
	b := UserIPBatch{ID: "first", Through: now, Records: []UserIPRecord{
		{Username: "alice", IP: "192.0.2.1", Family: 4, First: now - 10, Last: now, Observations: 2, LastActive: now, Source: 3},
		{Username: "alice", IP: "2001:db8::1", Family: 6, First: now, Last: now, Observations: 1, Source: 2},
	}}
	if err := st.ApplyUserIPBatch(b); err != nil {
		t.Fatal(err)
	}
	if err := st.ApplyUserIPBatch(b); err != nil {
		t.Fatal(err)
	}
	q := UserIPQuery{Username: "alice", Now: now, Limit: 1}
	page, err := st.UserIPHistory(q)
	if err != nil || page.Total != 2 || page.Matched != 2 || len(page.Items) != 1 || !page.HasMore || page.Items[0].Observations != 2 {
		t.Fatalf("first page: %+v %v", page, err)
	}
	q.Before, q.AfterIP = page.Items[0].Last, page.Items[0].IP
	page, err = st.UserIPHistory(q)
	if err != nil || len(page.Items) != 1 || page.Items[0].IP != "2001:db8::1" || page.HasMore {
		t.Fatalf("cursor: %+v %v", page, err)
	}
	q.Before, q.AfterIP, q.Family = 0, "", 6
	page, err = st.UserIPHistory(q)
	if err != nil || page.Total != 2 || page.Matched != 1 || len(page.Items) != 1 {
		t.Fatalf("family: %+v %v", page, err)
	}
	b.ID, b.Through = "second", now+60
	b.Records = []UserIPRecord{{Username: "alice", IP: "192.0.2.1", Family: 4, First: now + 60, Last: now + 60, Observations: 1, Source: 2}}
	if err := st.ApplyUserIPBatch(b); err != nil {
		t.Fatal(err)
	}
	q = UserIPQuery{Username: "alice", Now: now + 60, From: now + 1, Limit: 50}
	page, err = st.UserIPHistory(q)
	if err != nil || page.Total != 1 || page.New != 0 || page.Items[0].First != now-10 || page.Items[0].LastActive != now || page.Items[0].Observations != 3 || page.Items[0].Source != 2 {
		t.Fatalf("merge: %+v %v", page, err)
	}
	summaries, err := st.UserIPSummaries(now+1, now+60)
	if err != nil || summaries["alice"] != 1 {
		t.Fatalf("summaries: %v %v", summaries, err)
	}
	q.Search = "%"
	page, err = st.UserIPHistory(q)
	if err != nil || page.Matched != 0 {
		t.Fatalf("literal search: %+v %v", page, err)
	}
	if err = st.ResetUserIPHistory("alice"); err != nil {
		t.Fatal(err)
	}
	q.Search = ""
	page, err = st.UserIPHistory(q)
	if err != nil || page.Total != 0 {
		t.Fatalf("reset: %+v %v", page, err)
	}
	// The retry watermark survives a per-user reset.
	if err = st.ApplyUserIPBatch(b); err != nil {
		t.Fatal(err)
	}
	page, _ = st.UserIPHistory(q)
	if page.Total != 0 {
		t.Fatal("old retry resurrected cleared IP")
	}
	if err = st.ResetUserIPHistory(""); err != nil {
		t.Fatal(err)
	}
	b = UserIPBatch{ID: "cap", Through: now + 100}
	for i := 0; i < 260; i++ {
		b.Records = append(b.Records, UserIPRecord{Username: "alice", IP: fmt.Sprintf("198.51.%d.%d", i/256, i%256), Family: 4, First: now + int64(i)/10, Last: now + int64(i)/10, Observations: 1, Source: 2})
	}
	if err = st.ApplyUserIPBatch(b); err != nil {
		t.Fatal(err)
	}
	page, err = st.UserIPHistory(UserIPQuery{Username: "alice", Now: now + 100, Limit: 200})
	state, _ := st.UserIPCollectionState()
	if err != nil || page.Total != 256 || !state.Limited {
		t.Fatalf("cap: total=%d state=%+v err=%v", page.Total, state, err)
	}
	page, err = st.UserIPHistory(UserIPQuery{Username: "alice", Now: now + int64(st.UserIPRetention().Seconds()) + 200, Limit: 50})
	if err != nil || page.Total != 0 {
		t.Fatalf("retention: %+v %v", page, err)
	}
}

func TestUserIPNormalize(t *testing.T) {
	for _, tt := range []struct{ raw, want string }{{"::ffff:192.0.2.1", "192.0.2.1"}, {"2001:0db8:0:0::1", "2001:db8::1"}, {"127.0.0.1", "127.0.0.1"}, {"fe80::1", "fe80::1"}, {"fe80::1%eth0", ""}, {"0.0.0.0", ""}, {"ff02::1", ""}, {"192.0.2.1/24", ""}, {"192.0.2.1:42", ""}} {
		got, _, ok := NormalizeUserIP(tt.raw)
		if got != tt.want || (ok == nil) != (tt.want != "") {
			t.Errorf("%q -> %q %v", tt.raw, got, ok)
		}
	}
}

func TestUserIPMemoryExpirationAndNew(t *testing.T) {
	m, _ := NewMemoryHistory()
	defer m.Close()
	runUserIPExpirationAndNew(t, m)
}

func TestUserIPMemoryExpiryOnExport(t *testing.T) {
	m, _ := NewMemoryHistory()
	defer m.Close()
	runUserIPExpiryOnExport(t, m)
}

func runUserIPExpiryOnExport(t *testing.T, st HistoryStore) {
	now := time.Now().Unix()
	old := now - int64(st.UserIPRetention()/time.Second) - 10
	r := UserIPRecord{Username: "alice", IP: "192.0.2.1", Family: 4, First: old, Last: old, Observations: 1, Source: 2}
	if err := st.ApplyUserIPBatch(UserIPBatch{ID: "expired", Through: old, Records: []UserIPRecord{r}}); err != nil {
		t.Fatal(err)
	}
	data, err := st.(PortableStore).ExportData()
	if err != nil || len(data.UserIPs) != 0 {
		t.Fatalf("expired IP leaked into backup: %+v %v", data.UserIPs, err)
	}
	if err := st.PruneUserIPHistory(now); err != nil {
		t.Fatal(err)
	}
	page, err := st.UserIPHistory(UserIPQuery{Username: "alice", Now: old, Limit: 50})
	if err != nil || page.Total != 0 {
		t.Fatal("expired IP hidden but not deleted", page, err)
	}
}

func runUserIPExpirationAndNew(t *testing.T, st UserIPStore) {
	now := int64(1800000000)
	retention := int64(st.UserIPRetention() / time.Second)
	old := now - retention - 10
	r := UserIPRecord{Username: "alice", IP: "192.0.2.1", Family: 4, First: old, Last: old, Observations: 1, Source: 2}
	if err := st.ApplyUserIPBatch(UserIPBatch{ID: "old", Through: old, Records: []UserIPRecord{r}}); err != nil {
		t.Fatal(err)
	}
	r.First = now
	r.Last = now
	if err := st.ApplyUserIPBatch(UserIPBatch{ID: "new", Through: now, Records: []UserIPRecord{r}}); err != nil {
		t.Fatal(err)
	}
	page, _ := st.UserIPHistory(UserIPQuery{Username: "alice", Now: now, Limit: 50})
	if page.Total != 1 || page.Items[0].First != now || page.Items[0].Observations != 1 {
		t.Fatalf("expired row revived: %+v", page)
	}
	r.Username = "bob"
	r.First = old
	r.Last = now + 1
	if err := st.ApplyUserIPBatch(UserIPBatch{ID: "long-active", Through: now + 1, Records: []UserIPRecord{r}}); err != nil {
		t.Fatal(err)
	}
	page, _ = st.UserIPHistory(UserIPQuery{Username: "bob", Now: now + 1, Limit: 50})
	if page.New != 1 {
		t.Fatalf("all range must count retained old-first IP: %+v", page)
	}
}

func TestUserIPPortableAndStateIsolation(t *testing.T) {
	source, _ := NewMemoryHistory()
	defer source.Close()
	b := UserIPBatch{ID: "export", Through: 1800000000, Records: []UserIPRecord{{Username: "alice", IP: "2001:db8::1", Family: 6, First: 1800000000, Last: 1800000000, Observations: 1, Source: 2}}}
	if err := source.ApplyUserIPBatch(b); err != nil {
		t.Fatal(err)
	}
	data, err := source.ExportData()
	if err != nil || data.FormatVersion != portableFormatVersion || len(data.UserIPs) != 1 {
		t.Fatalf("export: %+v %v", data, err)
	}
	dest, _ := NewMemoryHistory()
	defer dest.Close()
	if err := dest.ImportData(data); err != nil {
		t.Fatal(err)
	}
	if err := dest.ImportData(data); err != ErrStoreNotEmpty {
		t.Fatal("accepted nonempty import", err)
	}
	statePath := filepath.Join(t.TempDir(), "state.json")
	state, _ := NewState(statePath)
	defer state.Close()
	if err := state.ImportData(data); err == nil {
		t.Fatal("IP history imported into state file")
	}
	legacy := PortableData{FormatVersion: 5, Policies: DefaultStoragePolicies()}
	for i, p := range legacy.Policies {
		if p.Category == StorageUserIPHistory {
			legacy.Policies = append(legacy.Policies[:i], legacy.Policies[i+1:]...)
			break
		}
	}
	legacy.Policies[1].RetentionDays = 123
	if err := state.ImportData(legacy); err != nil {
		t.Fatal(err)
	}
	policies, _ := state.ListStoragePolicies()
	if len(policies) != len(DefaultStoragePolicies()) || policies[1].RetentionDays != 123 {
		t.Fatalf("policy upgrade lost values: %+v", policies)
	}
	encoded, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, []byte("2001:db8")) || bytes.Contains(encoded, []byte("user_ip_collection")) {
		t.Fatal("historical data leaked to state")
	}
	policies[6].Enabled = false
	if err := ValidateStoragePolicies(policies); err == nil {
		t.Fatal("IP collection can be disabled")
	}
}
