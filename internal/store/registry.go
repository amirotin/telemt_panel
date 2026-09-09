package store

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/amirotin/telemt_panel/internal/store/sqlstore"
)

// OpenOptions contains driver-neutral connection settings. Constructors use
// only the fields relevant to their backend.
type OpenOptions struct {
	Driver string
	Path   string
}

// Constructor opens one configured store backend.
type Constructor func(OpenOptions) (HistoryStore, error)

type driverRegistration struct {
	constructor Constructor
	unavailable string
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

var driverRegistry = struct {
	sync.RWMutex
	entries map[string]driverRegistration
}{entries: make(map[string]driverRegistration)}

// Register makes a compiled driver available to Open. Registration is done
// from build-tagged driver files during package initialization.
func Register(name string, constructor Constructor) {
	register(name, driverRegistration{constructor: constructor})
}

// RegisterUnavailable makes a known but omitted driver return an actionable
// error instead of looking like an invalid configuration value.
func RegisterUnavailable(name, message string) {
	register(name, driverRegistration{unavailable: message})
}

func register(name string, registration driverRegistration) {
	name = strings.TrimSpace(strings.ToLower(name))
	if name == "" || (registration.constructor == nil) == (registration.unavailable == "") {
		panic("store: invalid driver registration")
	}
	driverRegistry.Lock()
	defer driverRegistry.Unlock()
	if _, exists := driverRegistry.entries[name]; exists {
		panic("store: duplicate driver registration: " + name)
	}
	driverRegistry.entries[name] = registration
}

// Open opens the requested registered backend.
func Open(options OpenOptions) (HistoryStore, error) {
	name := strings.TrimSpace(strings.ToLower(options.Driver))
	if name == "" {
		name = "memory"
	}
	driverRegistry.RLock()
	registration, ok := driverRegistry.entries[name]
	driverRegistry.RUnlock()
	if !ok {
		return nil, &UnknownDriverError{Driver: name}
	}
	if registration.constructor == nil {
		return nil, &UnavailableDriverError{Driver: name, Message: registration.unavailable}
	}
	options.Driver = name
	opened, err := registration.constructor(options)
	if err != nil {
		var unsupported *sqlstore.UnsupportedSchemaError
		if errors.As(err, &unsupported) {
			return nil, err
		}
		return nil, &OpenError{Driver: name, Err: err}
	}
	return opened, nil
}

// IsRuntimeOpenError reports whether err came from a compiled driver's runtime
// initialization rather than configuration, build-variant or schema gates.
func IsRuntimeOpenError(err error) bool {
	var target *OpenError
	return errors.As(err, &target)
}

// Drivers returns every compiled and known-unavailable driver in stable order.
func Drivers() []string {
	driverRegistry.RLock()
	defer driverRegistry.RUnlock()
	out := make([]string, 0, len(driverRegistry.entries))
	for name := range driverRegistry.entries {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// AvailableDrivers returns the drivers compiled into this binary.
func AvailableDrivers() []string {
	driverRegistry.RLock()
	defer driverRegistry.RUnlock()
	out := make([]string, 0, len(driverRegistry.entries))
	for name, registration := range driverRegistry.entries {
		if registration.constructor != nil {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

func init() {
	Register("memory", func(OpenOptions) (HistoryStore, error) {
		return NewMemoryHistory()
	})
}
