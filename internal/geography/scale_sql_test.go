//go:build !lite

package geography

import (
	"github.com/amirotin/telemt_panel/internal/store"
	"path/filepath"
	"testing"
)

func TestServiceScaleSQLite(t *testing.T) {
	history, err := store.NewSQLite(filepath.Join(t.TempDir(), "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer history.Close()
	runScaleProjection(t, history, 2000)
}
