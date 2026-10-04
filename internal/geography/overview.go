package geography

import (
	"context"
	"github.com/amirotin/telemt_panel/internal/geoip"
)

func copyPointer[T any](p *T) *T {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}
func cloneLocation(l Location) Location {
	l.CountryCode, l.Name, l.NameRU = copyPointer(l.CountryCode), copyPointer(l.Name), copyPointer(l.NameRU)
	l.CityID = copyPointer(l.CityID)
	if l.Location != nil {
		p := *l.Location
		p.AccuracyRadiusKM = copyPointer(p.AccuracyRadiusKM)
		l.Location = &p
	}
	return l
}
func cloneSource(src SourceMetadata) SourceMetadata {
	src.ObservedAt, src.AgeSeconds = copyPointer(src.ObservedAt), copyPointer(src.AgeSeconds)
	src.RequestedFrom, src.EffectiveFrom, src.RetentionDays = copyPointer(src.RequestedFrom), copyPointer(src.EffectiveFrom), copyPointer(src.RetentionDays)
	src.Durable = copyPointer(src.Durable)
	return src
}
func cloneGeoStatus(status geoip.Status) geoip.Status {
	status.Databases = append([]geoip.DatabaseStatus{}, status.Databases...)
	status.ActiveSource = copyPointer(status.ActiveSource)
	status.LastError = copyPointer(status.LastError)
	return status
}

// Overview renders bounded display points without changing the snapshot's totals.
func (s *Service) Overview(ctx context.Context, q OverviewQuery) (Overview, error) {
	if q.Country != "" && !validCountry(q.Country) || len(q.LocationID) > 160 {
		return Overview{}, ErrBadRequest
	}
	if q.Range != "" && !validRange(q.Range) || q.Family != "" && !validFamily(q.Family) {
		return Overview{}, ErrBadRequest
	}
	var entry *snapshot
	var err error
	if q.SnapshotID != "" {
		entry, err = s.pinned(q.SnapshotID)
		if err == nil && (q.Range != "" && q.Range != entry.key.window || q.Family != "" && q.Family != entry.key.family) {
			err = ErrBadRequest
		}
	} else {
		if q.Range == "" {
			q.Range = "now"
		}
		if q.Family == "" {
			q.Family = "all"
		}
		entry, err = s.acquire(ctx, key{window: q.Range, family: q.Family})
	}
	if err != nil {
		return Overview{}, err
	}
	out, err := s.view(ctx, entry, q)
	if err != nil {
		return Overview{}, err
	}
	if entry.epochs != s.currentEpochs() {
		return Overview{}, ErrSnapshotExpired
	}
	return out, nil
}

func (s *Service) view(ctx context.Context, entry *snapshot, q OverviewQuery) (Overview, error) {
	if err := ctx.Err(); err != nil {
		return Overview{}, err
	}
	out := Overview{SnapshotID: entry.id, Range: entry.key.window, Family: entry.key.family, AsOf: entry.asOf, GeneratedAt: entry.created.Unix(), ExpiresAt: entry.created.Unix() + 120, ServedAt: s.now().Unix(), Source: cloneSource(entry.source), GeoIP: cloneGeoStatus(entry.geoip), Countries: []Country{}, Points: []Location{}, Server: entry.server}
	out.Server.Origin = copyPointer(out.Server.Origin)
	if out.Server.Location != nil {
		l := *out.Server.Location
		l.AccuracyRadiusKM = copyPointer(l.AccuracyRadiusKM)
		out.Server.Location = &l
	}
	var selectedCountry *Country
	var selectedLocation *Location
	for _, c := range entry.data.Countries {
		if c.CountryCode == q.Country {
			v := c
			selectedCountry = &v
		}
	}
	if q.Country != "" && selectedCountry == nil {
		return Overview{}, ErrNotFound
	}
	for _, l := range entry.data.Locations {
		if l.ID == q.LocationID {
			v := cloneLocation(l)
			selectedLocation = &v
			break
		}
	}
	if q.LocationID != "" && selectedLocation == nil {
		return Overview{}, ErrNotFound
	}
	if selectedLocation != nil && q.Country != "" && (selectedLocation.CountryCode == nil || *selectedLocation.CountryCode != q.Country) {
		return Overview{}, ErrBadRequest
	}
	if selectedCountry != nil {
		out.Selection = *selectedCountry
	}
	if selectedLocation != nil {
		out.Selection = *selectedLocation
	}
	if entry.source.State == "unavailable" {
		out.State = "unavailable"
		return out, nil
	}
	totals, quality := entry.data.Totals, entry.data.Quality
	quality.CoordinateCoverage = copyPointer(quality.CoordinateCoverage)
	out.Totals, out.Quality = &totals, &quality
	stale := false
	if out.Source.ObservedAt != nil {
		age := out.ServedAt - *out.Source.ObservedAt
		if age >= 0 {
			out.Source.AgeSeconds = &age
		}
		if entry.key.window == "now" {
			stale = age < 0 || age > 30
		}
	}
	if entry.key.window == "now" && s.deps.Live != nil {
		state := s.deps.Live.UserIPSnapshotStatus(out.ServedAt).State
		stale = stale || state == "stale" || state == "unavailable"
	}
	out.State = "ready"
	switch {
	case stale:
		out.State = "stale"
	case totals.UniqueIPs == 0:
		out.State = "empty"
	case out.Source.Partial:
		out.State = "partial"
	}
	out.Countries = append(out.Countries, entry.data.Countries[:min(len(entry.data.Countries), 250)]...)
	total := 0
	selectedPresent := false
	for _, l := range entry.data.Locations {
		if l.Location == nil || q.Country != "" && (l.CountryCode == nil || *l.CountryCode != q.Country) {
			continue
		}
		total++
		if len(out.Points) < 200 {
			out.Points = append(out.Points, cloneLocation(l))
			selectedPresent = selectedPresent || l.ID == q.LocationID
		}
	}
	if selectedLocation != nil && selectedLocation.Location != nil && !selectedPresent {
		if len(out.Points) == 200 {
			out.Points[199] = *selectedLocation
		} else {
			out.Points = append(out.Points, *selectedLocation)
		}
	}
	out.Visible = Visible{Points: len(out.Points), TotalCoordinateLocations: total, OmittedPoints: total - len(out.Points), Countries: len(out.Countries), TotalCountries: len(entry.data.Countries), OmittedCountries: len(entry.data.Countries) - len(out.Countries)}
	return out, nil
}
