package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

type jsonBodyOptions struct {
	MaxBytes      int64
	RejectUnknown bool
	AllowEmpty    bool
}

var errJSONBodyTrailingData = errors.New("request body must contain exactly one JSON value")

type jsonBodyReadError struct {
	err error
}

func (e *jsonBodyReadError) Error() string { return e.err.Error() }
func (e *jsonBodyReadError) Unwrap() error { return e.err }

func decodeJSONBody(w http.ResponseWriter, r *http.Request, dst any, opts jsonBodyOptions) error {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, opts.MaxBytes))
	if err != nil {
		return &jsonBodyReadError{err: err}
	}
	if len(body) == 0 && opts.AllowEmpty {
		return nil
	}

	decoder := json.NewDecoder(bytes.NewReader(body))
	if opts.RejectUnknown {
		decoder.DisallowUnknownFields()
	}
	if err := decoder.Decode(dst); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errJSONBodyTrailingData
		}
		return fmt.Errorf("%w: %v", errJSONBodyTrailingData, err)
	}
	return nil
}
