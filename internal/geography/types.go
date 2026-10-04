// Package geography projects bounded IP observations into local network geography.
package geography

import (
	"errors"
	"github.com/amirotin/telemt_panel/internal/geoip"
	"net/netip"
)

// Range and Family select the source window and canonical address family.
type Range string
type Family string

// Pair is a temporary canonical address membership used only during construction.
type Pair struct {
	Username string
	IP       netip.Addr
}

// Input fixes the source window and quality for one aggregation.
type Input struct {
	Pairs  []Pair
	Range  Range
	Family Family
	AsOf   int64
	Source SourceMetadata
}

// Totals counts independent sets over the entire source.
type Totals struct {
	UniqueIPs     int64 `json:"unique_ips"`
	Accounts      int64 `json:"accounts"`
	CountryCount  int64 `json:"country_count"`
	LocationCount int64 `json:"location_count"`
}

// Quality partitions every unique IP into exactly one geolocation category.
type Quality struct {
	Located            int64    `json:"located"`
	CountryOnly        int64    `json:"country_only"`
	Private            int64    `json:"private"`
	NotFound           int64    `json:"not_found"`
	Unavailable        int64    `json:"unavailable"`
	CoordinateCoverage *float64 `json:"coordinate_coverage"`
	GeoConflicts       int64    `json:"geo_conflicts"`
}

// SourceMetadata describes the observation source independently of GeoIP availability.
type SourceMetadata struct {
	Kind           string `json:"kind"`
	ObservedAt     *int64 `json:"observed_at"`
	AgeSeconds     *int64 `json:"age_secs"`
	RequestedFrom  *int64 `json:"requested_from"`
	EffectiveFrom  *int64 `json:"effective_from"`
	RetentionDays  *int64 `json:"retention_days"`
	Durable        *bool  `json:"durable"`
	Partial        bool   `json:"partial"`
	InputTruncated bool   `json:"input_truncated"`
	CollectionGap  bool   `json:"collection_gap"`
	Pending        bool   `json:"pending"`
	InvalidUsers   int    `json:"invalid_users"`
	State          string `json:"-"`
}

// Country summarizes one known country without inventing map geometry.
type Country struct {
	ID          string `json:"id"`
	CountryCode string `json:"country_code"`
	Name        string `json:"name"`
	NameRU      string `json:"name_ru"`
	UniqueIPs   int64  `json:"unique_ips"`
	Accounts    int64  `json:"accounts"`
}

// Position is an actual group marker and a conservative approximate radius.
type Position struct {
	Latitude         float64 `json:"latitude"`
	Longitude        float64 `json:"longitude"`
	AccuracyRadiusKM *uint32 `json:"accuracy_radius_km"`
}

// Location describes a place or an accessible coordinate-less service group.
type Location struct {
	ID          string    `json:"id"`
	CountryCode *string   `json:"country_code"`
	Name        *string   `json:"name"`
	NameRU      *string   `json:"name_ru"`
	CityID      *uint32   `json:"city_id"`
	Location    *Position `json:"location"`
	UniqueIPs   int64     `json:"unique_ips"`
	Accounts    int64     `json:"accounts"`
}

// Membership refers to an interned account, never to a retained IP address.
type Membership struct {
	Account   uint32
	UniqueIPs uint32
}

// SnapshotData owns only aggregates and compact account memberships.
type SnapshotData struct {
	Totals      Totals
	Quality     Quality
	Countries   []Country
	Locations   []Location
	Accounts    []string
	Memberships map[string][]Membership
	OwnedBytes  int64
}

// Visible explains display limits without reducing overall totals.
type Visible struct {
	Points                   int `json:"points"`
	TotalCoordinateLocations int `json:"total_coordinate_locations"`
	OmittedPoints            int `json:"omitted_points"`
	Countries                int `json:"countries"`
	TotalCountries           int `json:"total_countries"`
	OmittedCountries         int `json:"omitted_countries"`
}

// ServerPosition hides the configured address from all map responses.
type ServerPosition struct {
	State    string          `json:"state"`
	Origin   *string         `json:"origin"`
	Label    string          `json:"label"`
	Location *geoip.Location `json:"location"`
}

// Overview is a view of a pinned projection with current source age.
type Overview struct {
	SnapshotID  string         `json:"snapshot_id"`
	GeneratedAt int64          `json:"generated_at"`
	ExpiresAt   int64          `json:"expires_at"`
	AsOf        int64          `json:"as_of"`
	ServedAt    int64          `json:"served_at"`
	Range       Range          `json:"range"`
	Family      Family         `json:"family"`
	State       string         `json:"state"`
	Totals      *Totals        `json:"totals"`
	Quality     *Quality       `json:"quality"`
	Source      SourceMetadata `json:"source"`
	GeoIP       geoip.Status   `json:"geoip"`
	Countries   []Country      `json:"countries"`
	Points      []Location     `json:"points"`
	Visible     Visible        `json:"visible"`
	Selection   any            `json:"selection"`
	Server      ServerPosition `json:"server"`
}

// LocationPage and UserPage are stable pages of an existing snapshot.
type LocationPage struct {
	SnapshotID string  `json:"snapshot_id"`
	Items      []any   `json:"items"`
	Total      int     `json:"total"`
	NextCursor *string `json:"next_cursor"`
}
type CountryPage struct {
	SnapshotID string    `json:"snapshot_id"`
	Items      []Country `json:"items"`
	Total      int       `json:"total"`
	NextCursor *string   `json:"next_cursor"`
}
type UserItem struct {
	Username  string `json:"username"`
	UniqueIPs int64  `json:"unique_ips"`
}
type UserPage struct {
	SnapshotID string     `json:"snapshot_id"`
	GroupID    string     `json:"group_id"`
	Items      []UserItem `json:"items"`
	Total      int        `json:"total"`
	NextCursor *string    `json:"next_cursor"`
}

var (
	// ErrCapacity rejects a result that exceeds the bounded memory or payload budget.
	ErrCapacity = errors.New("geography_capacity")
	// ErrBusy rejects work beyond the worker and waiter bounds.
	ErrBusy = errors.New("geography_busy")
	// ErrTimeout reports the build or waiter deadline.
	ErrTimeout = errors.New("geography_timeout")
	// ErrSourceChanged rejects repeated source changes during one construction.
	ErrSourceChanged = errors.New("geography_source_changed")
	// ErrSnapshotExpired revokes an evicted, invalidated or expired snapshot.
	ErrSnapshotExpired = errors.New("geography_snapshot_expired")
	// ErrBadRequest and ErrNotFound distinguish malformed filters from absent groups.
	ErrBadRequest = errors.New("bad_request")
	ErrNotFound   = errors.New("not_found")
)
