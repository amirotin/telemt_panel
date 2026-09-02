package store

import "strings"

// RuntimeStatus describes the configured and currently active backend. Error
// is deliberately safe for unauthenticated health responses and never carries
// a DSN or driver error verbatim.
type RuntimeStatus struct {
	ConfiguredDriver string
	ActiveDriver     string
	Error            string
}

type fallbackStore struct {
	Store
	configuredDriver string
	reason           string
}

// WithFallback marks a temporary store used because the configured remote
// backend was unavailable at process startup.
func WithFallback(temporary Store, configuredDriver, reason string) Store {
	return &fallbackStore{Store: temporary, configuredDriver: configuredDriver, reason: reason}
}

// Runtime returns backend status without exposing connection credentials.
func Runtime(st Store, configuredDriver string) RuntimeStatus {
	configuredDriver = strings.TrimSpace(strings.ToLower(configuredDriver))
	if configuredDriver == "" {
		configuredDriver = "memory"
	}
	status := RuntimeStatus{ConfiguredDriver: configuredDriver, ActiveDriver: st.Info().Driver}
	if fallback, ok := st.(*fallbackStore); ok {
		status.ConfiguredDriver = fallback.configuredDriver
		status.Error = fallback.reason
	}
	return status
}
