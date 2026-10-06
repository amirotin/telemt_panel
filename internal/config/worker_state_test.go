package config

import (
	"strings"
	"testing"
)

func TestWorkerStateDirectoryCanPersistOutsideRuntimeData(t *testing.T) {
	cfg, err := load(t, "data_dir = \"/tmp/telemt-panel\"\n"+minimal+"\n[updates]\nworker_state_dir = \"/etc/telemt-panel/updater\"\n")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.WorkerStateDir() != "/etc/telemt-panel/updater" || cfg.DataDir != "/tmp/telemt-panel" {
		t.Fatalf("worker=%q runtime=%q", cfg.WorkerStateDir(), cfg.DataDir)
	}
	if report := (&Source{Config: cfg}).Report(); report.WorkerStateDir != cfg.WorkerStateDir() {
		t.Fatalf("inspection path=%q", report.WorkerStateDir)
	}
	legacy, err := load(t, minimal)
	if err != nil || legacy.WorkerStateDir() != "/var/lib/telemt-panel/updater" {
		t.Fatalf("default worker directory: %+v, %v", legacy, err)
	}
}

func TestWorkerStateDirectoryRejectsRelativeOrRootPath(t *testing.T) {
	for _, path := range []string{"relative", "/", "/etc/../tmp/updater"} {
		_, err := load(t, minimal+"\n[updates]\nworker_state_dir = \""+path+"\"\n")
		if err == nil || !strings.Contains(err.Error(), "updates.worker_state_dir") {
			t.Fatalf("path=%q err=%v", path, err)
		}
	}
}
