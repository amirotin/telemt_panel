//go:build !lite

package store

import (
	"path/filepath"
	"testing"
)

func TestSQLiteStoreContract(t *testing.T) {
	runStoreContract(t, func(t *testing.T) Store {
		history, err := NewSQLite(filepath.Join(t.TempDir(), "panel.db"))
		if err != nil {
			t.Fatal(err)
		}
		state, err := NewState(filepath.Join(t.TempDir(), "panel-state.json"))
		if err != nil {
			_ = history.Close()
			t.Fatal(err)
		}
		combined, err := NewComposite(state, history)
		if err != nil {
			_ = history.Close()
			_ = state.Close()
			t.Fatal(err)
		}
		return combined
	})
}
