//go:build lite

package store

func openReadOnlySQLite(string, []StoragePolicy) (HistoryStore, error) {
	return nil, &UnavailableDriverError{Driver: "sqlite", Message: "sqlite is unavailable in the lite build"}
}
