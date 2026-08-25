package telemt

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"testing"
)

// normalizeLeaf is the deepest level in the fixture type graph below —
// exercises normalization inside a slice element (normalizeValue's
// recursion into v.Index(i)).
type normalizeLeaf struct {
	Tags []string `json:"tags"`
}

// normalizeMid sits one level up: a plain (non-pointer) nested struct with
// its own slice field, plus a slice of normalizeLeaf (so each element's
// own Tags field must also get normalized) and a pointer to a leaf (nil
// pointers must stay nil; non-nil ones must still be walked).
type normalizeMid struct {
	Names   []string         `json:"names"`
	Leaves  []normalizeLeaf  `json:"leaves"`
	NilLeaf *normalizeLeaf   `json:"nil_leaf"`
	SetLeaf *normalizeLeaf   `json:"set_leaf"`
	Blob    json.RawMessage  `json:"blob"`
	Tags    map[string][]int `json:"tags"` // maps deliberately untouched
}

// normalizeFixture is the top-level table-test type: a struct whose only
// field is another struct (so the walk has to descend through a
// non-pointer struct field to reach the interesting parts), matching how
// the real SDK types nest (Gated[T].Data -> *T -> struct -> ... -> slice).
type normalizeFixture struct {
	Mid normalizeMid `json:"mid"`
}

func TestNormalizeSlices_NullArraysAtSeveralDepthsBecomeEmpty(t *testing.T) {
	// Every array-shaped field below is either an explicit JSON null or an
	// omitted key — both decode to a nil Go slice before normalization.
	raw := []byte(`{
		"mid": {
			"names": null,
			"leaves": [{"tags": null}, {"tags": ["x"]}],
			"set_leaf": {"tags": null}
		}
	}`)

	var got normalizeFixture
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	normalizeSlices(&got)

	checks := []struct {
		name string
		got  []string
	}{
		{"mid.names", got.Mid.Names},
		{"mid.leaves[0].tags (element inside a slice)", got.Mid.Leaves[0].Tags},
		{"mid.set_leaf.tags (through a non-nil pointer)", got.Mid.SetLeaf.Tags},
	}
	for _, c := range checks {
		if c.got == nil {
			t.Errorf("%s = nil, want non-nil empty slice", c.name)
		}
		if len(c.got) != 0 {
			t.Errorf("%s = %v, want empty", c.name, c.got)
		}
	}

	// A slice that already had elements is untouched (not truncated) —
	// normalization only replaces nil, never rewrites present data.
	if len(got.Mid.Leaves) != 2 || got.Mid.Leaves[1].Tags == nil || got.Mid.Leaves[1].Tags[0] != "x" {
		t.Errorf("mid.leaves = %+v, want the second element's tags preserved", got.Mid.Leaves)
	}

	// A nil pointer is left nil — normalization must never allocate
	// through an absent optional struct just to reach a slice inside it.
	if got.Mid.NilLeaf != nil {
		t.Errorf("mid.nil_leaf = %+v, want nil (untouched)", got.Mid.NilLeaf)
	}

	// json.RawMessage ([]byte-kind) is left nil — it's an opaque JSON
	// value container, not a JSON array; forcing it non-nil would
	// (if ever marshaled without omitempty) wire as "" rather than being
	// omitted, which is meaningless for a raw section blob.
	if got.Mid.Blob != nil {
		t.Errorf("mid.blob = %#v, want nil (byte slices are excluded)", got.Mid.Blob)
	}

	// A nil map is left nil — out of scope by design (see normalize.go's
	// doc comment); must not panic either.
	if got.Mid.Tags != nil {
		t.Errorf("mid.tags = %#v, want nil (maps untouched)", got.Mid.Tags)
	}
}

// TestNormalizeSlices_TopLevelSlice covers the case where T itself is a
// slice (e.g. Users, ActiveIPs) rather than a struct wrapping one.
func TestNormalizeSlices_TopLevelSlice(t *testing.T) {
	var out []normalizeLeaf
	if err := json.Unmarshal([]byte(`null`), &out); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if out != nil {
		t.Fatalf("precondition failed: expected nil after unmarshaling JSON null")
	}
	normalizeSlices(&out)
	if out == nil || len(out) != 0 {
		t.Errorf("out = %#v, want non-nil empty slice", out)
	}
}

// TestNormalizeSlices_NilOrNonPointerInputIsNoop covers normalizeSlices'
// own guard clause directly — a nil interface or a non-pointer argument
// must not panic (defensive; every real call site always passes &out).
func TestNormalizeSlices_NilOrNonPointerInputIsNoop(t *testing.T) {
	normalizeSlices(nil)
	normalizeSlices(normalizeLeaf{}) // not a pointer
	var nilPtr *normalizeLeaf
	normalizeSlices(nilPtr) // nil pointer
}

// TestNormalizeSlices_RealSDKType exercises the actual decode path
// (get[T], via a real *Client call) against a fixture with nulls at
// several depths in a real, nested SDK type — RuntimeMePoolStatePayload,
// reached through the Gated[T] wrapper exactly as MePoolState() returns
// it — rather than only the synthetic fixture types above.
func TestNormalizeSlices_RealSDKType(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true,"data":{
			"enabled": true,
			"generated_at_epoch_secs": 5000,
			"data": {
				"generations": {
					"active_generation": 3, "warm_generation": 3,
					"pending_hardswap_generation": 0, "pending_hardswap_age_secs": null,
					"draining_generations": null
				},
				"hardswap": {"enabled": true, "pending": false},
				"writers": {
					"total": 0, "alive_non_draining": 0, "draining": 0, "degraded": 0,
					"contour": {"warm": 0, "active": 0, "draining": 0},
					"health": {"healthy": 0, "degraded": 0, "draining": 0}
				},
				"refill": {"inflight_endpoints_total": 0, "inflight_dc_total": 0, "by_dc": null}
			}
		},"revision":"r"}`))
	})

	got, err := c.MePoolState(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got.Data == nil {
		t.Fatal("Data is nil, want a populated payload")
	}
	if got.Data.Generations.DrainingGenerations == nil {
		t.Error("Generations.DrainingGenerations is nil (JSON null in the fixture), want non-nil empty")
	}
	if got.Data.Refill.ByDc == nil {
		t.Error("Refill.ByDc is nil (JSON null in the fixture), want non-nil empty")
	}

	// Round-trip through json.Marshal to prove the wire-level guarantee
	// the mini-task is actually about: these keys must serialize as `[]`,
	// never `null`.
	out, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(out, &raw); err != nil {
		t.Fatal(err)
	}
	data := raw["data"].(map[string]any)
	if v := data["generations"].(map[string]any)["draining_generations"]; !reflect.DeepEqual(v, []any{}) {
		t.Errorf("marshaled draining_generations = %#v, want []", v)
	}
	if v := data["refill"].(map[string]any)["by_dc"]; !reflect.DeepEqual(v, []any{}) {
		t.Errorf("marshaled by_dc = %#v, want []", v)
	}
}
