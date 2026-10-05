//go:build !lite

package store

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"

	"github.com/amirotin/telemt_panel/internal/store/sqlstore"
	sqlitedriver "github.com/ncruces/go-sqlite3/driver"
)

func openReadOnlySQLite(path string, policies []StoragePolicy) (HistoryStore, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("read-only history must already exist: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("read-only history must be a regular file")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	u := &url.URL{Scheme: "file", Path: abs}
	query := u.Query()
	query.Set("mode", "ro")
	query.Set("_txlock", "deferred")
	query.Add("_pragma", "query_only(ON)")
	query.Add("_pragma", "busy_timeout(5000)")
	u.RawQuery = query.Encode()
	db, err := sqlitedriver.Open(u.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	ctx, cancel := historyOperationContext(context.Background())
	defer cancel()
	version, err := sqlstore.ReadOnlySchemaVersion(ctx, db)
	if err != nil {
		db.Close()
		return nil, err
	}
	history := newSQLStore(db, path)
	history.readOnly = true
	history.schema = version
	history.policies = policyMap(policies)
	return history, nil
}
