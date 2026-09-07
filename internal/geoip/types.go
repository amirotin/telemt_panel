// Package geoip manages verified local MaxMind DB readers for panel-owned
// address enrichment. It never sends observed addresses to an external service.
package geoip

import (
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
)

// Source identifies where GeoIP database files come from.
type Source string

const (
	// SourceCommunity, SourceURLs, and SourceFiles are supported database sources.
	SourceCommunity Source = "community"
	SourceURLs      Source = "urls"
	SourceFiles     Source = "files"
)

// Schedule controls automatic GeoIP database refreshes.
type Schedule string

const (
	// ScheduleWeekly, ScheduleDaily, and ScheduleManual are supported refresh schedules.
	ScheduleWeekly Schedule = "weekly"
	ScheduleDaily  Schedule = "daily"
	ScheduleManual Schedule = "manual"
)

// Kind identifies the records supplied by a GeoIP database.
type Kind string

const (
	// KindCountry, KindASN, and KindCity are supported database kinds.
	KindCountry Kind = "country"
	KindASN     Kind = "asn"
	KindCity    Kind = "city"
)

const (
	// StateDisabled, StateEmpty, StateReady, StateUpdating, and StateError are manager states.
	StateDisabled = "disabled"
	StateEmpty    = "empty"
	StateReady    = "ready"
	StateUpdating = "updating"
	StateError    = "error"

	// ResultFound, ResultPrivate, and ResultNotFound are lookup result states.
	ResultFound    = "found"
	ResultPrivate  = "private"
	ResultNotFound = "not_found"
)

var (
	// ErrBusy reports an update already in progress.
	ErrBusy = errors.New("geoip operation already in progress")
	// ErrDisabled reports an update requested while GeoIP is disabled.
	ErrDisabled = errors.New("geoip is disabled")
	// ErrInvalidConfig reports invalid GeoIP configuration.
	ErrInvalidConfig = errors.New("invalid geoip configuration")
)

// DatabaseConfig selects and locates one database kind.
type DatabaseConfig struct {
	Enabled  bool   `json:"enabled"`
	Location string `json:"location"`
}

// Config is the persisted desired GeoIP configuration.
type Config struct {
	Enabled  bool           `json:"enabled"`
	Source   Source         `json:"source"`
	Schedule Schedule       `json:"schedule"`
	Country  DatabaseConfig `json:"country"`
	ASN      DatabaseConfig `json:"asn"`
	City     DatabaseConfig `json:"city"`
}

// DefaultConfig returns the initial disabled community configuration.
func DefaultConfig() Config {
	return Config{
		Source: SourceCommunity, Schedule: ScheduleWeekly,
		Country: DatabaseConfig{Enabled: true},
		ASN:     DatabaseConfig{Enabled: true},
	}
}

// Validate checks configuration values without accessing their locations.
func (c Config) Validate() error {
	switch c.Source {
	case SourceCommunity, SourceURLs, SourceFiles:
	default:
		return fmt.Errorf("%w: unknown source", ErrInvalidConfig)
	}
	switch c.Schedule {
	case ScheduleWeekly, ScheduleDaily, ScheduleManual:
	default:
		return fmt.Errorf("%w: unknown schedule", ErrInvalidConfig)
	}
	if c.Enabled && !c.Country.Enabled && !c.ASN.Enabled && !c.City.Enabled {
		return fmt.Errorf("%w: select at least one database", ErrInvalidConfig)
	}
	for _, database := range c.databases() {
		if !database.config.Enabled || c.Source == SourceCommunity {
			continue
		}
		if database.config.Location == "" {
			return fmt.Errorf("%w: %s location is required", ErrInvalidConfig, database.kind)
		}
		switch c.Source {
		case SourceURLs:
			u, err := url.Parse(database.config.Location)
			if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" {
				return fmt.Errorf("%w: %s must be an HTTPS URL without userinfo or fragment", ErrInvalidConfig, database.kind)
			}
		case SourceFiles:
			if !filepath.IsAbs(database.config.Location) {
				return fmt.Errorf("%w: %s must be an absolute path", ErrInvalidConfig, database.kind)
			}
		}
	}
	return nil
}

type configuredDatabase struct {
	kind   Kind
	config DatabaseConfig
}

func (c Config) databases() []configuredDatabase {
	return []configuredDatabase{
		{kind: KindCountry, config: c.Country},
		{kind: KindASN, config: c.ASN},
		{kind: KindCity, config: c.City},
	}
}

// DatabaseStatus describes one database in the active bundle.
type DatabaseStatus struct {
	Kind            Kind  `json:"kind"`
	BuildEpochSecs  int64 `json:"build_epoch_secs"`
	LoadedEpochSecs int64 `json:"loaded_epoch_secs"`
}

// Status describes GeoIP availability and the active database bundle.
type Status struct {
	State        string           `json:"state"`
	Available    bool             `json:"available"`
	ActiveSource *Source          `json:"active_source"`
	Databases    []DatabaseStatus `json:"databases"`
	LastError    *string          `json:"last_error"`
}

// Settings combines desired configuration with runtime status.
type Settings struct {
	Config Config `json:"config"`
	Status Status `json:"status"`
}

// Result contains the local enrichment for one IP address.
type Result struct {
	State         string `json:"state"`
	CountryCode   string `json:"country_code"`
	CountryName   string `json:"country_name"`
	CountryNameRU string `json:"country_name_ru"`
	City          string `json:"city"`
	CityRU        string `json:"city_ru"`
	ASN           uint   `json:"asn"`
	Organization  string `json:"organization"`
}
