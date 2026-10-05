package store

import (
	"errors"
	"io"
	"strings"
	"sync"

	"github.com/amirotin/telemt_panel/internal/store/sqlstore"
)

// ReadOnlyTransfer exports detached state and a consistent readonly history snapshot.
type ReadOnlyTransfer interface {
	Driver() string
	ExportJSON(io.Writer) error
	Close() error
}

type readOnlyTransfer struct {
	state    PortableData
	history  portableHistoryJSONExporter
	driver   string
	close    func() error
	once     sync.Once
	closeErr error
}

func (s *readOnlyTransfer) Driver() string               { return s.driver }
func (s *readOnlyTransfer) ExportJSON(w io.Writer) error { return s.history.exportJSON(w, s.state) }
func (s *readOnlyTransfer) Close() error {
	s.once.Do(func() { s.closeErr = s.close() })
	return s.closeErr
}

// OpenReadOnlyTransfer never initializes state/history or binds runtime identity.
func OpenReadOnlyTransfer(statePath string, options OpenOptions) (ReadOnlyTransfer, error) {
	state, err := NewState(statePath)
	if err != nil {
		return nil, err
	}
	// State loading only reads JSON. Detach its persistence before obtaining data.
	state.statePath = ""
	data, err := state.ExportData()
	state.Close()
	if err != nil {
		return nil, err
	}
	clearPortableHistory(&data)
	data, err = normalizePortableData(data)
	if err != nil {
		return nil, err
	}
	name := strings.ToLower(strings.TrimSpace(options.Driver))
	if name == "" {
		name = "memory"
	}
	var history HistoryStore
	switch name {
	case "memory":
		history, err = NewMemoryHistory()
	case "sqlite":
		history, err = openReadOnlySQLite(options.Path, data.Policies)
		if err != nil {
			var unavailable *UnavailableDriverError
			var unsupported *sqlstore.UnsupportedSchemaError
			if errors.As(err, &unavailable) || errors.As(err, &unsupported) {
				return nil, err
			}
			return nil, &OpenError{Driver: name, Err: err}
		}
	default:
		return nil, &UnknownDriverError{Driver: name}
	}
	if err != nil {
		return nil, err
	}
	return &readOnlyTransfer{state: data, history: history.(portableHistoryJSONExporter), driver: name, close: history.Close}, nil
}
