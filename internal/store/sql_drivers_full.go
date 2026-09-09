//go:build !lite

package store

func openSQLite(options OpenOptions) (HistoryStore, error) {
	return NewSQLite(options.Path)
}

func availableDrivers() []string { return []string{"memory", "sqlite"} }
