package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func userIPLimitPolicies(t *testing.T, limit int) []StoragePolicy {
	t.Helper()
	policies := DefaultStoragePolicies()
	for i := range policies {
		if policies[i].Category == StorageUserIPHistory {
			raw := fmt.Sprintf(`{"category":"user_ip_history","enabled":true,"retention_days":30,"max_ips_per_user":%d}`, limit)
			if err := json.Unmarshal([]byte(raw), &policies[i]); err != nil {
				t.Fatal(err)
			}
		}
	}
	return policies
}

func userIPLimitBatch(n int, now int64) UserIPBatch {
	b := UserIPBatch{ID: fmt.Sprint(now), Through: now}
	for i := 0; i < n; i++ {
		at := now - int64(n-i)
		b.Records = append(b.Records, UserIPRecord{Username: "alice", IP: fmt.Sprintf("2001:db8::%x", i+1), Family: 6, First: at, Last: at, Observations: 1, Source: 2})
	}
	return b
}

func runUserIPConfigurableLimit(t *testing.T, st HistoryStore) {
	t.Helper()
	now := time.Now().Unix()
	for _, limit := range []int{512, 0} {
		if err := st.ApplyStoragePolicies(userIPLimitPolicies(t, limit)); err != nil {
			t.Fatal(err)
		}
		if err := st.ResetUserIPHistory(""); err != nil {
			t.Fatal(err)
		}
		now++
		if err := st.ApplyUserIPBatch(userIPLimitBatch(500, now)); err != nil {
			t.Fatal(err)
		}
		page, err := st.UserIPHistory(UserIPQuery{Username: "alice", Now: now, Limit: 200})
		state, stateErr := st.UserIPCollectionState()
		if err != nil || stateErr != nil || page.Total != 500 || state.Limited {
			t.Fatalf("limit %d retained %d addresses, limited=%v: %v %v", limit, page.Total, state.Limited, err, stateErr)
		}
		before := st.UserIPEpoch()
		if err := st.ApplyStoragePolicies(userIPLimitPolicies(t, 3)); err != nil {
			t.Fatal(err)
		}
		page, err = st.UserIPHistory(UserIPQuery{Username: "alice", Now: now, Limit: 200})
		state, _ = st.UserIPCollectionState()
		if err != nil || page.Total != 3 || !state.Limited || st.UserIPEpoch() == before {
			t.Fatalf("lowered limit did not prune and invalidate: total=%d state=%+v epoch=%d: %v", page.Total, state, st.UserIPEpoch(), err)
		}
		if page.Items[0].IP != "2001:db8::1f4" || page.Items[2].IP != "2001:db8::1f2" {
			t.Fatalf("limit retained older observations: %+v", page.Items)
		}
		before = st.UserIPEpoch()
		if err := st.ApplyStoragePolicies(userIPLimitPolicies(t, 3)); err != nil || st.UserIPEpoch() != before {
			t.Fatalf("equivalent policy invalidated snapshot: %v", err)
		}
	}
}

func TestUserIPMemoryConfigurableLimit(t *testing.T) {
	m, _ := NewMemoryHistory()
	defer m.Close()
	runUserIPConfigurableLimit(t, m)
}

func TestUserIPUnlimitedRetainsMemoryGlobalCap(t *testing.T) {
	m, _ := NewMemoryHistory()
	defer m.Close()
	if err := m.ApplyStoragePolicies(userIPLimitPolicies(t, 0)); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	if err := m.ApplyUserIPBatch(userIPLimitBatch(20000, now)); err != nil {
		t.Fatal(err)
	}
	b := userIPLimitBatch(1, now+1)
	b.Records[0].IP = "2001:db8::ffff"
	if err := m.ApplyUserIPBatch(b); err != nil {
		t.Fatal(err)
	}
	page, err := m.UserIPHistory(UserIPQuery{Username: "alice", Now: now + 1, Limit: 200})
	state, _ := m.UserIPCollectionState()
	if err != nil || page.Total != 20000 || !state.Limited || page.Items[0].IP != "2001:db8::ffff" {
		t.Fatalf("global cap: total=%d limited=%v error=%v", page.Total, state.Limited, err)
	}
}

func TestUserIPLimitPolicyValidation(t *testing.T) {
	for _, limit := range []int{-1, 100001} {
		if err := ValidateStoragePolicies(userIPLimitPolicies(t, limit)); err == nil {
			t.Errorf("accepted invalid limit %d", limit)
		}
	}
	for _, limit := range []int{0, 1, 100000} {
		if err := ValidateStoragePolicies(userIPLimitPolicies(t, limit)); err != nil {
			t.Errorf("rejected limit %d: %v", limit, err)
		}
	}
	policies := DefaultStoragePolicies()
	if err := json.Unmarshal([]byte(`{"category":"technical","enabled":true,"retention_days":30,"max_ips_per_user":0}`), &policies[0]); err != nil {
		t.Fatal(err)
	}
	if err := ValidateStoragePolicies(policies); err == nil {
		t.Error("accepted IP cap on a different category")
	}
}

func mutateUserIPPolicyLimit(t *testing.T, policies []StoragePolicy, limit int) {
	t.Helper()
	for i := range policies {
		if policies[i].Category != StorageUserIPHistory {
			continue
		}
		field := reflect.ValueOf(&policies[i]).Elem().FieldByName("MaxIPsPerUser")
		if !field.IsValid() || field.IsNil() {
			t.Fatal("explicit IP limit absent from returned policy")
		}
		field.Elem().SetInt(int64(limit))
	}
}

func TestUserIPPolicyCopiesAndPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	m, err := NewMemory(path)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	policies := userIPLimitPolicies(t, 0)
	if err := m.ReplaceStoragePolicies(policies); err != nil {
		t.Fatal(err)
	}
	mutateUserIPPolicyLimit(t, policies, 2)
	listed, _ := m.ListStoragePolicies()
	mutateUserIPPolicyLimit(t, listed, 3)
	exported, err := m.ExportData()
	if err != nil {
		t.Fatal(err)
	}
	mutateUserIPPolicyLimit(t, exported.Policies, 4)
	actual, _ := m.ListStoragePolicies()
	if !reflect.DeepEqual(actual, userIPLimitPolicies(t, 0)) {
		t.Fatal("policy pointer escaped through input, getter, or export")
	}
	reopened, err := NewMemory(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	actual, _ = reopened.ListStoragePolicies()
	if !reflect.DeepEqual(actual, userIPLimitPolicies(t, 0)) {
		t.Fatal("unlimited policy did not survive reopen")
	}
}

func TestUserIPMemoryPolicyWriteFailurePreservesHistory(t *testing.T) {
	m, _ := NewMemoryHistory()
	defer m.Close()
	if err := m.ReplaceStoragePolicies(userIPLimitPolicies(t, 0)); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	if err := m.ApplyUserIPBatch(userIPLimitBatch(10, now)); err != nil {
		t.Fatal(err)
	}
	blocker := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(blocker, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	m.statePath = filepath.Join(blocker, "state.json")
	before := m.UserIPEpoch()
	if err := m.ReplaceStoragePolicies(userIPLimitPolicies(t, 2)); err == nil {
		t.Fatal("policy persistence unexpectedly succeeded")
	}
	page, err := m.UserIPHistory(UserIPQuery{Username: "alice", Now: now, Limit: 50})
	actual, _ := m.ListStoragePolicies()
	if err != nil || page.Total != 10 || m.UserIPEpoch() != before || !reflect.DeepEqual(actual, userIPLimitPolicies(t, 0)) {
		t.Fatalf("failed policy write changed policy/history: total=%d epoch=%d error=%v", page.Total, m.UserIPEpoch(), err)
	}
	m.statePath = ""
}

func TestUserIPPortableUsesBackupLimit(t *testing.T) {
	now := time.Now().Unix()
	for _, limit := range []int{512, 0} {
		m, _ := NewMemoryHistory()
		defer m.Close()
		if err := m.ApplyStoragePolicies(userIPLimitPolicies(t, 2)); err != nil {
			t.Fatal(err)
		}
		b := userIPLimitBatch(500, now)
		data := PortableData{FormatVersion: portableFormatVersion, Policies: userIPLimitPolicies(t, limit), UserIPs: b.Records, UserIPCollection: &UserIPCollection{BatchID: b.ID, Since: now - 500, Through: now}}
		if err := m.ImportData(data); err != nil {
			t.Fatalf("valid backup with limit %d rejected: %v", limit, err)
		}
		mutateUserIPPolicyLimit(t, data.Policies, 1)
		page, err := m.UserIPHistory(UserIPQuery{Username: "alice", Now: now, Limit: 200})
		actual, _ := m.ListStoragePolicies()
		if err != nil || page.Total != 500 || !reflect.DeepEqual(actual, userIPLimitPolicies(t, limit)) {
			t.Fatalf("restored policy/history changed: total=%d error=%v", page.Total, err)
		}
	}
	b := userIPLimitBatch(257, now)
	legacy := PortableData{FormatVersion: portableFormatVersion, UserIPs: b.Records, UserIPCollection: &UserIPCollection{BatchID: b.ID, Since: now - 257, Through: now}}
	if _, err := normalizePortableData(legacy); err == nil {
		t.Fatal("legacy backup exceeded the default per-user limit")
	}
}

func runUserIPLegacyImportUsesDefault(t *testing.T, st interface {
	HistoryStore
	PortableStore
	ListStoragePolicies() ([]StoragePolicy, error)
}) {
	t.Helper()
	policies := userIPLimitPolicies(t, 2)
	policies[0].RetentionDays = 17
	if err := st.ApplyStoragePolicies(policies); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	b := userIPLimitBatch(3, now)
	data := PortableData{FormatVersion: portableFormatVersion, UserIPs: b.Records, UserIPCollection: &UserIPCollection{BatchID: b.ID, Since: now - 3, Through: now}}
	if err := st.ImportData(data); err != nil {
		t.Fatal(err)
	}
	page, err := st.UserIPHistory(UserIPQuery{Username: "alice", Now: now, Limit: 50})
	if err != nil || page.Total != 3 || st.UserIPLimit() != 256 {
		t.Fatalf("legacy backup adopted destination cap: total=%d limit=%d error=%v", page.Total, st.UserIPLimit(), err)
	}
	actual, err := st.ListStoragePolicies()
	if err != nil || actual[0].RetentionDays != 17 {
		t.Fatalf("unrelated omitted policy changed: %+v %v", actual, err)
	}
	if _, err := st.ExportData(); err != nil {
		t.Fatalf("restored legacy backup cannot be exported: %v", err)
	}
}

func TestUserIPMemoryLegacyImportUsesDefault(t *testing.T) {
	m, _ := NewMemoryHistory()
	defer m.Close()
	runUserIPLegacyImportUsesDefault(t, m)
}

func TestUserIPImportWriteFailurePreservesPolicy(t *testing.T) {
	m, _ := NewMemoryHistory()
	defer m.Close()
	policies := userIPLimitPolicies(t, 2)
	policies[0].RetentionDays = 17
	if err := m.ReplaceStoragePolicies(policies); err != nil {
		t.Fatal(err)
	}
	blocker := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(blocker, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	m.statePath = filepath.Join(blocker, "state.json")
	defer func() { m.statePath = "" }()
	before := m.UserIPEpoch()
	if err := m.ImportData(PortableData{FormatVersion: portableFormatVersion, Policies: userIPLimitPolicies(t, 0)}); err == nil {
		t.Fatal("import unexpectedly persisted")
	}
	actual, _ := m.ListStoragePolicies()
	if !reflect.DeepEqual(actual, policies) || m.UserIPEpoch() != before {
		t.Fatal("failed import replaced the pre-existing policies")
	}
}
