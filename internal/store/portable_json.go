package store

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"sort"
)

const portableJSONBufferSize = 32 * 1024

type portableJSONWriter struct {
	out        *bufio.Writer
	firstField bool
	err        error
}

func newPortableJSONWriter(out io.Writer) *portableJSONWriter {
	w := &portableJSONWriter{out: bufio.NewWriterSize(out, portableJSONBufferSize), firstField: true}
	w.raw("{")
	return w
}

func (w *portableJSONWriter) raw(value string) {
	if w.err != nil {
		return
	}
	_, w.err = io.WriteString(w.out, value)
}

func (w *portableJSONWriter) jsonValue(value any) {
	if w.err != nil {
		return
	}
	raw, err := json.Marshal(value)
	if err != nil {
		w.err = err
		return
	}
	_, w.err = w.out.Write(raw)
}

func (w *portableJSONWriter) fieldPrefix(name string) {
	if !w.firstField {
		w.raw(",")
	}
	w.firstField = false
	w.jsonValue(name)
	w.raw(":")
}

func (w *portableJSONWriter) field(name string, value any) {
	w.fieldPrefix(name)
	w.jsonValue(value)
}

func (w *portableJSONWriter) header(data PortableData) {
	w.field("format_version", data.FormatVersion)
	w.field("sessions", data.Sessions)
	w.field("subpage_nonces", data.SubpageNonces)
	w.field("settings", data.Settings)
	w.field("journal", data.Journal)
	if len(data.Policies) != 0 {
		w.field("storage_policies", data.Policies)
	}
	if len(data.Audit) != 0 {
		w.field("audit", data.Audit)
	}
	if len(data.WebAuthnUserHandle) != 0 {
		w.field("webauthn_user_handle", data.WebAuthnUserHandle)
	}
	if len(data.WebAuthnCredentials) != 0 {
		w.field("webauthn_credentials", data.WebAuthnCredentials)
	}
}

func (w *portableJSONWriter) beginArray(name string) bool {
	w.fieldPrefix(name)
	w.raw("[")
	return true
}

func (w *portableJSONWriter) beginObject(name string) bool {
	w.fieldPrefix(name)
	w.raw("{")
	return true
}

func (w *portableJSONWriter) element(first *bool, value any) {
	if !*first {
		w.raw(",")
	}
	*first = false
	w.jsonValue(value)
}

func (w *portableJSONWriter) objectKey(first *bool, name string) {
	if !*first {
		w.raw(",")
	}
	*first = false
	w.jsonValue(name)
	w.raw(":")
}

func (w *portableJSONWriter) finish() error {
	w.raw("}\n")
	if w.err != nil {
		return w.err
	}
	if err := w.out.Flush(); err != nil {
		return err
	}
	return nil
}

func writePortableJSON(out io.Writer, data PortableData) error {
	w := newPortableJSONWriter(out)
	w.header(data)
	writeMaterializedPortableHistory(w, data)
	if err := w.finish(); err != nil {
		return fmt.Errorf("encode store export: %w", err)
	}
	return nil
}

func writeMaterializedPortableHistory(w *portableJSONWriter, data PortableData) {
	if len(data.Metrics) != 0 {
		firstName := w.beginObject("metrics")
		for _, name := range sortedKeys(data.Metrics) {
			w.objectKey(&firstName, name)
			if data.Metrics[name] == nil {
				w.jsonValue(nil)
				continue
			}
			w.raw("[")
			firstPoint := true
			for _, point := range data.Metrics[name] {
				w.element(&firstPoint, point)
			}
			w.raw("]")
		}
		w.raw("}")
	}
	writeSliceField(w, "events", data.Events)
	writeSliceField(w, "user_traffic", data.UserTraffic)
	writeSliceField(w, "user_traffic_buckets", data.UserTrafficBuckets)
	if data.UserTrafficCollector != nil {
		w.field("user_traffic_collector", data.UserTrafficCollector)
	}
	writeSliceField(w, "user_ip_history", data.UserIPs)
	if data.UserIPCollection != nil {
		w.field("user_ip_collection", data.UserIPCollection)
	}
}

func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func writeSliceField[T any](w *portableJSONWriter, name string, values []T) {
	if len(values) == 0 {
		return
	}
	first := w.beginArray(name)
	for _, value := range values {
		w.element(&first, value)
	}
	w.raw("]")
}
