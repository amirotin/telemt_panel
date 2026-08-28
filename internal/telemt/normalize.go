package telemt

import "reflect"

// normalizeSlices walks v — a pointer to a value freshly decoded from a
// Telemt response — and replaces every nil slice found at any depth
// (through struct fields, non-nil pointers, and slice elements) with a
// non-nil, empty slice of the same type. It is the SDK's one normalization
// point for the panel's output contract: "arrays are always [], never
// null" — Telemt frequently omits a slice-typed field, or the SDK's own
// zero value is a nil slice, and either one round-trips through
// encoding/json as JSON `null` rather than `[]` unless normalized first
// (verified on the wire, e.g. `draining_generations: null` when the ME
// pool is closed). Every consumer downstream of a decoded SDK value —
// REST handlers that pass a typed response straight through, and hub
// topic snapshots that re-marshal an already-decoded struct into a
// composite payload — inherits this guarantee for free, without adding
// its own `?? []`-equivalent per field.
//
// Maps are deliberately left untouched: unlike a nil slice, a nil map is
// sometimes a meaningful "absent/unsupported" signal the panel already
// relies on (e.g. hub.usersSnapshot.Quota is an explicit JSON null when
// the quota capability isn't available — see that field's doc comment); a
// generic pass has no way to tell that case apart from "just happens to be
// nil", so this stays scoped to slices, which have no such ambiguity (an
// absent/unsupported list is exactly as valid a `[]` as a present-but-empty
// one, and the SDK never uses a slice's nilness as a signal itself).
func normalizeSlices(v any) {
	rv := reflect.ValueOf(v)
	if rv.Kind() != reflect.Ptr || rv.IsNil() {
		return
	}
	normalizeValue(rv.Elem())
}

// normalizeValue is normalizeSlices' recursive step over an addressable
// reflect.Value. Invariant: the value came straight out of json.Unmarshal,
// so the pointer graph is a tree (JSON cannot encode back-references) and
// the walk needs no cycle guard. Interface-typed fields are not descended
// into: a struct held in an interface is not settable through it, and no
// SDK type uses one — the default branch is the deliberate "unsupported
// kind, leave as is" edge.
func normalizeValue(v reflect.Value) {
	switch v.Kind() {
	case reflect.Array:
		for i := 0; i < v.Len(); i++ {
			normalizeValue(v.Index(i))
		}
	case reflect.Slice:
		// []byte / json.RawMessage (Elem().Kind() == Uint8) are opaque
		// JSON-value containers, not JSON arrays: a nil one means "this
		// JSON value was absent", which must stay absent rather than
		// becoming an empty value of ambiguous shape (the config
		// sections' raw values are exactly this kind of payload). Left
		// untouched; only genuine element slices are normalized below.
		if v.Type().Elem().Kind() == reflect.Uint8 {
			return
		}
		if v.IsNil() {
			if v.CanSet() {
				v.Set(reflect.MakeSlice(v.Type(), 0, 0))
			}
			return
		}
		for i := 0; i < v.Len(); i++ {
			normalizeValue(v.Index(i))
		}
	case reflect.Ptr:
		if !v.IsNil() {
			normalizeValue(v.Elem())
		}
	case reflect.Struct:
		for i := 0; i < v.NumField(); i++ {
			field := v.Field(i)
			if field.CanSet() {
				normalizeValue(field)
			}
		}
	}
}
