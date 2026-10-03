package host

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
)

// LogSourceError describes a source failure without exposing captured logs.
type LogSourceError struct {
	Reason   string
	ExitCode *int
	cause    error
}

// Error returns a safe description suitable for an authenticated diagnostic.
func (e *LogSourceError) Error() string {
	switch e.Reason {
	case "file_missing":
		return "the configured log file does not exist"
	case "permission_denied":
		return "the panel does not have permission to read the log source"
	case "command_missing":
		return "the log source command is not installed or is not on PATH"
	case "target_missing":
		return "the configured log target could not be found"
	case "daemon_unavailable":
		return "the Docker daemon is unavailable"
	case "source_timeout":
		return "the log source did not respond in time"
	case "command_failed":
		return "the log source command failed"
	default:
		return "the log source could not be read"
	}
}

// Unwrap preserves the underlying error for source-specific handling.
func (e *LogSourceError) Unwrap() error { return e.cause }

// LogDiagnostic returns only allowlisted metadata, never arbitrary stderr.
func LogDiagnostic(err error) *LogSourceError {
	var diagnostic *LogSourceError
	if errors.As(err, &diagnostic) {
		return diagnostic
	}
	return newLogSourceError(err, "")
}

func newLogSourceError(err error, reason string) *LogSourceError {
	e := &LogSourceError{Reason: reason, cause: err}
	var exitError *ExitError
	var osExitError *exec.ExitError
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		e.Reason = "source_timeout"
	case errors.Is(err, exec.ErrNotFound):
		e.Reason = "command_missing"
	case errors.Is(err, os.ErrPermission):
		e.Reason = "permission_denied"
	case errors.Is(err, os.ErrNotExist):
		e.Reason = "file_missing"
	case errors.As(err, &exitError):
		code := exitError.Code
		e.ExitCode = &code
		if e.Reason == "" {
			e.Reason = "command_failed"
		}
	case errors.As(err, &osExitError):
		code := osExitError.ExitCode()
		e.ExitCode = &code
		if e.Reason == "" {
			e.Reason = "command_failed"
		}
	}
	if e.Reason == "" {
		e.Reason = "read_failed"
	}
	return e
}

// commandLogReason inspects only bounded diagnostics. Its input is never
// returned to callers: docker stderr may contain application secrets.
func commandLogReason(text string) string {
	if len(text) > 4096 {
		return ""
	}
	text = strings.ToLower(strings.TrimSpace(text))
	if strings.HasPrefix(text, "{") || strings.HasPrefix(text, "[") {
		return ""
	}
	switch {
	case strings.Contains(text, "permission denied"), strings.Contains(text, "insufficient permissions"), strings.Contains(text, "access denied"):
		return "permission_denied"
	case strings.Contains(text, "no such container"), strings.Contains(text, "no such object"), strings.HasPrefix(text, "unit ") && strings.Contains(text, "not found"):
		return "target_missing"
	case strings.Contains(text, "cannot connect to the docker daemon"), strings.Contains(text, "is the docker daemon running"), strings.HasPrefix(text, "error during connect"):
		return "daemon_unavailable"
	default:
		return ""
	}
}
