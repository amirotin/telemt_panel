package telemt

import (
	"encoding/json"
	"testing"
)

// TestGatedDataOmittedVsExplicitNull covers 07-telemt-sdk.md's "known
// gotchas" claim about gate wrappers head-on: Gated[T].Data must decode to
// nil whether Telemt omits the `data` key entirely (the behavior actually
// observed in runtime_min.rs/runtime_edge.rs/model.rs's MinimalAllData — see
// this package's doc comment on Gated[T]) or sends an explicit JSON null (in
// case a future/different Telemt build does), and must decode to a non-nil
// payload when data is present. Table-driven per the task brief's
// "known rakes" requirement.
func TestGatedDataOmittedVsExplicitNull(t *testing.T) {
	type payload struct {
		Foo string `json:"foo"`
	}

	tests := []struct {
		name     string
		wire     string
		wantData bool
		wantFoo  string
	}{
		{
			name:     "data key omitted entirely (real Telemt wire behavior)",
			wire:     `{"enabled":false,"reason":"feature_disabled","generated_at_epoch_secs":5000}`,
			wantData: false,
		},
		{
			name:     "data explicit null",
			wire:     `{"enabled":false,"reason":"feature_disabled","generated_at_epoch_secs":5000,"data":null}`,
			wantData: false,
		},
		{
			name:     "reason omitted entirely when enabled",
			wire:     `{"enabled":true,"generated_at_epoch_secs":5000,"data":{"foo":"bar"}}`,
			wantData: true,
			wantFoo:  "bar",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var g Gated[payload]
			if err := json.Unmarshal([]byte(tc.wire), &g); err != nil {
				t.Fatal(err)
			}
			if (g.Data != nil) != tc.wantData {
				t.Fatalf("data = %v, want present=%v", g.Data, tc.wantData)
			}
			if tc.wantData && g.Data.Foo != tc.wantFoo {
				t.Errorf("data.foo = %q, want %q", g.Data.Foo, tc.wantFoo)
			}
		})
	}
}

// TestGatedEncodeOmitsNilData proves the SDK's own encoding side (relevant
// if anything round-trips a Gated[T] back to JSON, e.g. a future hub cache)
// matches Telemt's wire behavior: a nil Data omits the key rather than
// emitting an explicit null.
func TestGatedEncodeOmitsNilData(t *testing.T) {
	type payload struct {
		Foo string `json:"foo"`
	}
	g := Gated[payload]{Enabled: false, Reason: "feature_disabled", GeneratedAtEpochSecs: 5000}
	buf, err := json.Marshal(g)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(buf, &raw); err != nil {
		t.Fatal(err)
	}
	if _, present := raw["data"]; present {
		t.Errorf("encoded data key present with nil Data: %s", buf)
	}
}
