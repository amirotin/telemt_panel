package main

import (
	"strings"
	"testing"

	"github.com/amirotin/telemt_panel/internal/config"
)

func TestNewStoreRefusesSQLiteDriver(t *testing.T) {
	cfg := &config.Config{Store: config.StoreConfig{Driver: "sqlite", Path: "/tmp/panel.db"}}
	_, err := newStore(cfg)
	if err == nil {
		t.Fatal("newStore: want an error for the unimplemented sqlite driver")
	}
	if !strings.Contains(err.Error(), `"sqlite"`) || !strings.Contains(err.Error(), `"memory"`) {
		t.Errorf("newStore error = %q, want it to name both the rejected and the supported driver", err.Error())
	}
}

func TestNewStoreBuildsMemoryStore(t *testing.T) {
	for _, driver := range []string{"", "memory"} {
		cfg := &config.Config{Store: config.StoreConfig{Driver: driver}}
		st, err := newStore(cfg)
		if err != nil {
			t.Fatalf("newStore(driver=%q): %v", driver, err)
		}
		if st == nil {
			t.Fatalf("newStore(driver=%q): want a non-nil store", driver)
		}
		st.Close()
	}
}
