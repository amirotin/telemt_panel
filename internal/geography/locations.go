package geography

import (
	"fmt"
	"github.com/amirotin/telemt_panel/internal/geoip"
	"math"
	"strings"
	"unicode"
)

func countryCode(r *geoip.Result) string {
	if r == nil || len(r.CountryCode) != 2 {
		return ""
	}
	for _, c := range r.CountryCode {
		if c < 'A' || c > 'Z' {
			return ""
		}
	}
	return r.CountryCode
}
func validPosition(l *geoip.Location) bool {
	return l != nil && !math.IsNaN(l.Latitude) && !math.IsNaN(l.Longitude) && !math.IsInf(l.Latitude, 0) && !math.IsInf(l.Longitude, 0) && math.Abs(l.Latitude) <= 90 && math.Abs(l.Longitude) <= 180
}
func rounded(v float64) string {
	v = math.Round(v*1e4) / 1e4
	if v == 0 {
		v = 0
	}
	return fmt.Sprintf("%.4f", v)
}

// LocationID uses country/GeoNames or rounded coordinates, never localized labels.
func LocationID(r *geoip.Result) string {
	if r == nil || r.CountryConflict {
		return ""
	}
	code := countryCode(r)
	if code == "" {
		code = "ZZ"
	}
	if r.CityID != nil && *r.CityID > 0 {
		return fmt.Sprintf("city:%s:%d", code, *r.CityID)
	}
	if validPosition(r.Location) {
		return "point:" + code + ":" + rounded(r.Location.Latitude) + ":" + rounded(r.Location.Longitude)
	}
	return ""
}

func label(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	runes := []rune(s)
	if len(runes) > 80 {
		s = string(runes[:79]) + "…"
	}
	return s
}
func minLabel(a, b string) string {
	b = label(b)
	if a == "" || b != "" && b < a {
		return b
	}
	return a
}
func optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
func distance(a, b geoip.Location) float64 {
	lat1, lat2 := a.Latitude*math.Pi/180, b.Latitude*math.Pi/180
	dlat, dlon := lat2-lat1, (b.Longitude-a.Longitude)*math.Pi/180
	h := math.Pow(math.Sin(dlat/2), 2) + math.Cos(lat1)*math.Cos(lat2)*math.Pow(math.Sin(dlon/2), 2)
	return 2 * 6371.0088 * math.Asin(math.Sqrt(min(1, max(0, h))))
}
func groupPosition(points []geoip.Location) *Position {
	if len(points) == 0 {
		return nil
	}
	marker := points[0]
	for _, p := range points[1:] {
		if p.Latitude < marker.Latitude || p.Latitude == marker.Latitude && p.Longitude < marker.Longitude {
			marker = p
		}
	}
	out := &Position{Latitude: marker.Latitude, Longitude: marker.Longitude}
	var radius float64
	for _, p := range points {
		if p.AccuracyRadiusKM == nil {
			return out
		}
		radius = max(radius, distance(marker, p)+float64(*p.AccuracyRadiusKM))
	}
	if radius <= math.MaxUint32 {
		r := uint32(math.Ceil(radius))
		out.AccuracyRadiusKM = &r
	}
	return out
}
