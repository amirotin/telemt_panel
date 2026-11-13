package telemttest

import (
	"context"
	"testing"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

func TestNativeConfigScenarioPreflightAndState(t *testing.T) {
	fake := New(Scenario{NativeConfig: true})
	defer fake.Close()
	client := telemt.New(fake.URL, "")
	ctx := context.Background()
	state, rev, err := client.ConfigState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if rev == nil || state.DesiredStatus != "valid" {
		t.Fatalf("state: %#v revision %v", state, rev)
	}
	validation, _, err := client.ValidateConfig(ctx, map[string]any{"network": map[string]any{"dns_overrides": []string{"example.org:443:192.0.2.1"}}}, *rev, "", telemt.ReloadQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if !validation.Valid || validation.Runtime.RuntimeMatch == "" || len(validation.Apply.WatcherPaths) != 1 {
		t.Fatalf("validation: %#v", validation)
	}
	after, _, err := client.ConfigState(ctx)
	if err != nil || after.Runtime.RuntimeMatch != state.Runtime.RuntimeMatch {
		t.Fatal("validation mutated runtime", err)
	}
}
