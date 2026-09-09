package store

import (
	"errors"
	"fmt"
	"strings"

	"github.com/amirotin/telemt_panel/internal/store/sqlstore"
)

// OpenOptions contains driver-neutral connection settings. Backends use only
// the fields relevant to them.
type OpenOptions struct {
	Driver string
	Path   string
}

// UnknownDriverError reports a driver name that the panel does not know.
type UnknownDriverError struct{ Driver string }

func (e *UnknownDriverError) Error() string { return fmt.Sprintf("store: unknown driver %q", e.Driver) }

// UnavailableDriverError reports a known driver omitted from this build.
type UnavailableDriverError struct {
	Driver  string
	Message string
}

func (e *UnavailableDriverError) Error() string { return "store: " + e.Message }

// OpenError reports a backend that is compiled in but could not be opened.
// Callers may use this distinction to fall back only for runtime connection
// failures, while configuration and build-variant errors remain fatal.
type OpenError struct {
	Driver string
	Err    error
}

func (e *OpenError) Error() string { return fmt.Sprintf("store: open %s: %v", e.Driver, e.Err) }
func (e *OpenError) Unwrap() error { return e.Err }

// Open opens the requested backend.
func Open(options OpenOptions) (HistoryStore, error) {
	name := strings.TrimSpace(strings.ToLower(options.Driver))
	if name == "" {
		name = "memory"
	}
	options.Driver = name

	switch name {
	case "memory":
		return NewMemoryHistory()
	case "sqlite":
		opened, err := openSQLite(options)
		if err == nil {
			return opened, nil
		}
		var unavailable *UnavailableDriverError
		if errors.As(err, &unavailable) {
			return nil, err
		}
		var unsupported *sqlstore.UnsupportedSchemaError
		if errors.As(err, &unsupported) {
			return nil, err
		}
		if options.Path == "" {
			return nil, err
		}
		return nil, &OpenError{Driver: name, Err: err}
	default:
		return nil, &UnknownDriverError{Driver: name}
	}
}

// IsRuntimeOpenError reports whether err came from a compiled driver's runtime
// initialization rather than configuration, build-variant or schema gates.
func IsRuntimeOpenError(err error) bool {
	var target *OpenError
	return errors.As(err, &target)
}

// AvailableDrivers returns the drivers compiled into this binary.
func AvailableDrivers() []string {
	return availableDrivers()
}
