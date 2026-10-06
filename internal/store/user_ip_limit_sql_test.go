//go:build !lite

package store

import (
	"bytes"
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

func TestUserIPSQLiteConfigurableLimit(t *testing.T) {
	s, _ := newSQLite(t)
	runUserIPConfigurableLimit(t, s)
}

func TestUserIPSQLitePolicyRollbackPreservesLimit(t *testing.T) {
	s, _ := newSQLite(t)
	if err := s.ApplyStoragePolicies(userIPLimitPolicies(t, 0)); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	if err := s.ApplyUserIPBatch(userIPLimitBatch(10, now)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`CREATE TRIGGER reject_ip_prune BEFORE UPDATE ON user_ip_history_collection BEGIN SELECT RAISE(ABORT, 'prune metadata failed'); END`); err != nil {
		t.Fatal(err)
	}
	before := s.UserIPEpoch()
	if err := s.ApplyStoragePolicies(userIPLimitPolicies(t, 2)); err == nil {
		t.Fatal("prune failure did not fail policy update")
	}
	actual, _ := s.ListStoragePolicies()
	page, err := s.UserIPHistory(UserIPQuery{Username: "alice", Now: now, Limit: 50})
	if err != nil || page.Total != 10 || s.UserIPEpoch() != before || !reflect.DeepEqual(actual, userIPLimitPolicies(t, 0)) {
		t.Fatalf("rollback changed policy/history: total=%d epoch=%d error=%v", page.Total, s.UserIPEpoch(), err)
	}
}

func TestUserIPSQLitePortableConfigurableLimit(t *testing.T) {
	s, _ := newSQLite(t)
	if err := s.ApplyStoragePolicies(userIPLimitPolicies(t, 0)); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	if err := s.ApplyUserIPBatch(userIPLimitBatch(500, now)); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := s.ExportJSON(&output); err != nil {
		t.Fatal(err)
	}
	var data PortableData
	if err := json.Unmarshal(output.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	if len(data.UserIPs) != 500 || !reflect.DeepEqual(data.Policies, userIPLimitPolicies(t, 0)) {
		t.Fatalf("streamed backup lost policy or addresses: records=%d policies=%+v", len(data.UserIPs), data.Policies)
	}
	dest, _ := newSQLite(t)
	if err := dest.ApplyStoragePolicies(userIPLimitPolicies(t, 2)); err != nil {
		t.Fatal(err)
	}
	if err := dest.ImportData(data); err != nil {
		t.Fatal(err)
	}
	if err := dest.ApplyUserIPBatch(userIPLimitBatch(500, now+1)); err != nil {
		t.Fatal(err)
	}
	page, err := dest.UserIPHistory(UserIPQuery{Username: "alice", Now: now + 1, Limit: 200})
	if err != nil || page.Total != 500 {
		t.Fatalf("import kept destination limit: total=%d error=%v", page.Total, err)
	}
}

func TestUserIPCompositePortableConfigurableLimit(t *testing.T) {
	state, _ := NewState("")
	history, _ := newSQLite(t)
	source, err := NewComposite(state, history)
	if err != nil {
		t.Fatal(err)
	}
	if err := source.ReplaceStoragePolicies(userIPLimitPolicies(t, 0)); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	if err := source.ApplyUserIPBatch(userIPLimitBatch(500, now)); err != nil {
		t.Fatal(err)
	}
	data, err := source.ExportData()
	if err != nil {
		t.Fatal(err)
	}
	destState, _ := NewState("")
	destHistory, _ := newSQLite(t)
	dest, err := NewComposite(destState, destHistory)
	if err != nil {
		t.Fatal(err)
	}
	if err := dest.ReplaceStoragePolicies(userIPLimitPolicies(t, 2)); err != nil {
		t.Fatal(err)
	}
	if err := dest.ImportData(data); err != nil {
		t.Fatal(err)
	}
	page, err := dest.UserIPHistory(UserIPQuery{Username: "alice", Now: now, Limit: 200})
	if err != nil || page.Total != 500 {
		t.Fatalf("composite lost imported addresses: total=%d error=%v", page.Total, err)
	}
}

func TestUserIPSQLiteLegacyImportUsesDefault(t *testing.T) {
	s, _ := newSQLite(t)
	runUserIPLegacyImportUsesDefault(t, s)
}

func TestUserIPCompositeLegacyImportUsesDefault(t *testing.T) {
	state, _ := NewState("")
	history, _ := newSQLite(t)
	combined, err := NewComposite(state, history)
	if err != nil {
		t.Fatal(err)
	}
	runUserIPLegacyImportUsesDefault(t, combined)
}
