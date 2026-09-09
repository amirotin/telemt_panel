//go:build lite

package store

func openSQLite(OpenOptions) (HistoryStore, error) {
	return nil, &UnavailableDriverError{
		Driver:  "sqlite",
		Message: "this build has no sqlite driver — install the full variant (telemt-panel, not telemt-panel-lite)",
	}
}

func availableDrivers() []string { return []string{"memory"} }
