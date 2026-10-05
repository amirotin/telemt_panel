package host

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
)

func TestPrivilegedInspectOnlyReadsAndRejectsRuntimePathMismatch(t *testing.T) {
	allow := AllowLists{StagingPrefix: "/var/lib/telemt-panel/staging", TargetBinaries: map[string]string{"panel": "/usr/local/bin/telemt-panel", "telemt": "/bin/telemt"}, HelperPath: "/usr/local/bin/telemt-panel", PolicyPath: DefaultPrivilegedPolicyPath}
	for _, change := range []string{"none", "staging", "binary", "schema", "old sudoers"} {
		t.Run(change, func(t *testing.T) {
			policy := PrivilegedPolicy{Version: 1, StagingRoot: allow.StagingPrefix, Binaries: map[string]string{"panel": allow.TargetBinaries["panel"], "telemt": allow.TargetBinaries["telemt"]}}
			if change == "staging" {
				policy.StagingRoot = "/other/staging"
			} else if change == "binary" {
				policy.Binaries["telemt"] = "/other/telemt"
			} else if change == "schema" {
				policy.Version = 2
			}
			var calls []recordedCommand
			run := NewSudoCmdRunner(func(_ context.Context, name string, args ...string) ([]byte, []byte, error) {
				calls = append(calls, recordedCommand{name, args})
				if change == "old sudoers" {
					return nil, []byte("sudo: command not allowed"), errors.New("denied")
				}
				data, err := json.Marshal(policy)
				return data, nil, err
			})
			err := CheckPrivilegedPolicy(context.Background(), allow, run)
			if (err == nil) != (change == "none") {
				t.Fatalf("inspection error=%v", err)
			}
			want := []recordedCommand{{"sudo", []string{"-n", "--", allow.HelperPath, "privileged", "--policy", allow.PolicyPath, "inspect"}}}
			if !reflect.DeepEqual(calls, want) {
				t.Fatalf("inspect spawned mutation or wrong argv: %+v", calls)
			}
		})
	}
}
