package telemt

import (
	"context"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"
)

func TestSameVersionRuntimePublicationRefreshesCapabilities(t *testing.T) {
	for _, trigger := range []string{"reload_status", "reload_count", "process_start"} {
		t.Run(trigger, func(t *testing.T) {
			var enabled atomic.Bool
			var count, started atomic.Uint64
			started.Store(100)
			var schemaReads atomic.Int32
			c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v1/system/info":
					fmt.Fprintf(w, `{"ok":true,"data":{"version":"3.5.17","config_reload_count":%d,"process_started_at_epoch_secs":%d}}`, count.Load(), started.Load())
				case "/v1/system/reload/7":
					fmt.Fprint(w, `{"ok":true,"data":{"reload_id":7,"target_generation":2,"state":"succeeded"}}`)
				case "/v1/runtime/connections/summary":
					fmt.Fprintf(w, `{"ok":true,"data":{"enabled":%t}}`, enabled.Load())
				case "/v1/capabilities":
					fmt.Fprint(w, `{"ok":true,"data":{"operations":[],"api_version":"v1","schema_version":1,"software_version":"3.5.17","config_schema":"/v1/config/schema","read_only":false,"availability_scope":"feature_and_runtime_source_prerequisites_not_request_success"}}`)
				case "/v1/config/schema":
					schemaReads.Add(1)
					path := "web.before"
					if enabled.Load() {
						path = "web.after"
					}
					fmt.Fprintf(w, `{"ok":true,"data":{"fields":[{"path":%q,"sensitivity":"public","api":{"config_read":false,"config_write":false,"read_routes":[],"write_routes":[],"null_behavior":"not_editable"}}],"schema_version":1,"value_schema_dialect":"https://json-schema.org/draft/2020-12/schema","defaults_scope":"unconfigured_type_defaults_before_loader_normalization","validation_scope":"value_constraints_are_not_a_substitute_for_full_config_validation","path_notation":"dot_members; []=array_element; {name}=dynamic_map_key","config_patch":{"objects":"recursive_merge","arrays":"replace_whole_array","object_null_members":"ignored_before_candidate_validation","reset":"not_supported","source_ownership":"one_independently_writable_source_per_mutation","if_match":"optional_source_manifest_revision"}}}`, path)
				default:
					http.NotFound(w, r)
				}
			})
			ctx := context.Background()
			if _, err := c.SystemInfo(ctx); err != nil {
				t.Fatal(err)
			}
			markBothCapabilitiesAbsent(t, c)
			before, err := c.Capabilities(ctx)
			if err != nil || before.RuntimeEdge {
				t.Fatalf("before=%+v err=%v", before, err)
			}
			enabled.Store(true)
			refresh := func() {
				t.Helper()
				if trigger == "reload_status" {
					if _, err := c.ReloadStatus(ctx, 7); err != nil {
						t.Fatal(err)
					}
				} else {
					if _, err := c.SystemInfo(ctx); err != nil {
						t.Fatal(err)
					}
				}
			}
			if trigger == "reload_count" {
				count.Store(1)
			}
			if trigger == "process_start" {
				started.Store(101)
			}
			refresh()
			after, err := c.Capabilities(ctx)
			if err != nil || !after.RuntimeEdge {
				t.Errorf("same-version change kept stale caps: %+v err=%v", after, err)
			}
			if after.RotateSecret || after.UserEnableDisable {
				t.Errorf("reload discarded independently absent mutation routes: %+v", after)
			}
			schema, err := c.ConfigSchema(ctx)
			if err != nil || len(schema.Fields) != 1 || schema.Fields[0].Path != "web.after" {
				t.Errorf("schema stayed stale: %+v err=%v", schema, err)
			}
			refresh()
			if _, err := c.Capabilities(ctx); err != nil {
				t.Fatal(err)
			}
			if got := schemaReads.Load(); got != 2 {
				t.Errorf("schema reads=%d want 2 (repeat observation must stay cached)", got)
			}
		})
	}
}
