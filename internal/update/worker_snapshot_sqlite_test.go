//go:build !lite

package update

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/ncruces/go-sqlite3"
)

func TestWorkerRestoresSQLiteCommittedWALAfterCandidateMigration(t *testing.T) {
	_, cfg, _ := workerFixture(t)
	path := filepath.Join(cfg.DataDir, "history.db")
	db, err := sqlite3.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Config(sqlite3.DBCONFIG_NO_CKPT_ON_CLOSE, true); err != nil {
		t.Fatal(err)
	}
	if err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('old committed value');`); err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(path + "-wal"); err != nil || info.Size() == 0 {
		t.Fatalf("fixture must contain committed WAL: %v,%v", info, err)
	}
	cfg.SnapshotPaths = []string{path, path + "-wal", path + "-shm"}
	cfg.Health = func(_ context.Context, _ string, version string) error {
		db, err := sqlite3.Open(path)
		if err != nil {
			return err
		}
		defer db.Close()
		if version == "v1.1.0" {
			if err := db.Exec(`DROP TABLE marker; CREATE TABLE incompatible(value INTEGER); INSERT INTO incompatible VALUES(99);`); err != nil {
				return err
			}
			return errors.New("candidate failed after history migration")
		}
		statement, _, err := db.Prepare(`SELECT value FROM marker`)
		if err != nil {
			return err
		}
		defer statement.Close()
		if !statement.Step() || statement.ColumnText(0) != "old committed value" {
			t.Fatal("rollback lost committed WAL or retained candidate schema")
		}
		return nil
	}
	if err := RunWorker(context.Background(), cfg); err == nil {
		t.Fatal("candidate migration failure reported success")
	}
}
