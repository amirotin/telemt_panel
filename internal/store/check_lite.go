//go:build lite

package store

// CheckConnection reports that network database clients are absent from the
// lite build.
func CheckConnection(driver, _ string) error {
	if driver != "postgres" && driver != "mysql" {
		return &UnknownDriverError{Driver: driver}
	}
	return &UnavailableDriverError{
		Driver:  driver,
		Message: "this build has no " + driver + " driver — install the full variant (telemt-panel, not telemt-panel-lite)",
	}
}
