package hub

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestWeb358ComparisonIgnoresMeasurementAgesOnly(t *testing.T) {
	a := json.RawMessage(`{"status":{"enabled":true,"data":{"lifecycle":"running","lifecycle_age_ms":1000,"decoy_upstream":{"last_outcome":"ok","last_outcome_age_ms":1000},"operator_lifecycle":{"state":"running","epoch":3,"age_ms":1000,"drain":{"deadline_epoch_millis":7000,"remaining_sessions":2}},"capacity":{"rejections":[{"reason":"body_bytes_capacity","total":2}]}}}}`)
	b := json.RawMessage(strings.ReplaceAll(string(a), ":1000", ":99000"))
	before := append(json.RawMessage(nil), a...)
	if !bytes.Equal(diffKey("web", a), diffKey("web", b)) {
		t.Error("measurement ages caused an idle WEB snapshot change")
	}
	if !bytes.Equal(before, a) {
		t.Error("comparison mutated the age values sent on the wire")
	}
	for _, tc := range []struct {
		name, before, after string
	}{
		{"decoy outcome", `"last_outcome":"ok"`, `"last_outcome":"connect_timeout"`},
		{"operator state", `"state":"running"`, `"state":"paused"`},
		{"operator epoch", `"epoch":3`, `"epoch":4`},
		{"drain deadline", `"deadline_epoch_millis":7000`, `"deadline_epoch_millis":8000`},
		{"remaining sessions", `"remaining_sessions":2`, `"remaining_sessions":1`},
		{"rejection counter", `"total":2`, `"total":3`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			changed := json.RawMessage(strings.Replace(string(a), tc.before, tc.after, 1))
			if bytes.Equal(diffKey("web", a), diffKey("web", changed)) {
				t.Errorf("comparison ignored %s", tc.name)
			}
		})
	}
	if bytes.Equal(diffKey("runtime", a), diffKey("runtime", b)) {
		t.Error("WEB age suppression leaked into another topic")
	}
}
