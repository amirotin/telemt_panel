package auth

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// apiError is the panel's error envelope (api/openapi.yaml schema Error).
type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// WriteError writes the panel's standard {code, message} error body.
// Shared with internal/httpapi so every auth-related response — whether
// written by this package's middleware or by the httpapi handlers that
// call into it — uses the same envelope shape.
func WriteError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(apiError{Code: code, Message: message}); err != nil {
		slog.Error("auth: encode error response", "err", err)
	}
}
