package geography

import (
	"context"
	"github.com/amirotin/telemt_panel/internal/geoip"
	"net/netip"
	"sort"
	"strings"
)

type groupAccount struct{ group, account uint32 }
type locationBuilder struct {
	dto          Location
	name, nameRU string
	positions    []geoip.Location
}
type ipGroup struct{ country, location string }

// Aggregate counts independent IP/account sets and discards address-bearing indexes.
func Aggregate(ctx context.Context, input Input, resolved map[netip.Addr]*geoip.Result) (*SnapshotData, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if int64(len(input.Pairs))*256+int64(len(resolved))*256 > 64<<20 {
		return nil, ErrCapacity
	}
	pairs := append([]Pair(nil), input.Pairs...)
	for i := range pairs {
		pairs[i].IP = pairs[i].IP.Unmap()
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].Username != pairs[j].Username {
			return pairs[i].Username < pairs[j].Username
		}
		return pairs[i].IP.Compare(pairs[j].IP) < 0
	})
	out := &SnapshotData{Countries: []Country{}, Locations: []Location{}, Accounts: []string{}, Memberships: map[string][]Membership{}}
	countries := map[string]*Country{}
	locations := map[string]*locationBuilder{}
	seen := map[netip.Addr]ipGroup{}
	groupIDs := map[string]uint32{}
	groupNames := []string{}
	counts := map[groupAccount]uint32{}
	addMember := func(group string, account uint32) {
		index, ok := groupIDs[group]
		if !ok {
			index = uint32(len(groupNames))
			groupNames = append(groupNames, group)
			groupIDs[group] = index
		}
		counts[groupAccount{index, account}]++
	}
	var previous Pair
	var account uint32
	for i, p := range pairs {
		if i%512 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			buffers := int64(len(input.Pairs))*256 + int64(len(resolved))*256 + int64(len(seen))*112 + int64(len(counts))*48 + int64(len(locations))*640 + int64(len(countries))*192
			if buffers > 64<<20 {
				return nil, ErrCapacity
			}
		}
		if !p.IP.IsValid() || p.IP.Zone() != "" || p.Username == "" || len(p.Username) > 256 || input.Family == "4" && !p.IP.Is4() || input.Family == "6" && !p.IP.Is6() {
			continue
		}
		if p == previous {
			continue
		}
		previous = p
		if len(out.Accounts) == 0 || out.Accounts[len(out.Accounts)-1] != p.Username {
			account = uint32(len(out.Accounts))
			out.Accounts = append(out.Accounts, p.Username)
		}
		groups, exists := seen[p.IP]
		if !exists {
			r := resolved[p.IP]
			code := countryCode(r)
			id := LocationID(r)
			switch {
			case geoip.IsNonPublic(p.IP):
				out.Quality.Private++
				code = ""
				id = "unknown:private"
				r = nil
			case r == nil:
				out.Quality.Unavailable++
				code = ""
				id = "unknown:unavailable"
			case !r.CountryConflict && validPosition(r.Location):
				out.Quality.Located++
			case code != "":
				out.Quality.CountryOnly++
			default:
				out.Quality.NotFound++
			}
			if r != nil && r.CountryConflict {
				out.Quality.GeoConflicts++
			}
			if id == "" {
				if code != "" {
					id = "country-only:" + code
				} else {
					id = "unknown:not_found"
				}
			}
			groups = ipGroup{country: code, location: id}
			seen[p.IP] = groups
			b := locations[id]
			if b == nil {
				b = &locationBuilder{dto: Location{ID: id, CountryCode: optional(code)}}
				locations[id] = b
				if r != nil && !r.CountryConflict && r.CityID != nil {
					v := *r.CityID
					b.dto.CityID = &v
				}
			}
			b.dto.UniqueIPs++
			if r != nil && !r.CountryConflict {
				b.name, b.nameRU = minLabel(b.name, r.City), minLabel(b.nameRU, r.CityRU)
				if validPosition(r.Location) && !strings.HasPrefix(id, "unknown:") {
					b.positions = append(b.positions, *r.Location)
				}
			}
			if code != "" {
				c := countries[code]
				if c == nil {
					c = &Country{ID: "country:" + code, CountryCode: code}
					countries[code] = c
				}
				c.UniqueIPs++
				c.Name, c.NameRU = minLabel(c.Name, r.CountryName), minLabel(c.NameRU, r.CountryNameRU)
			}
		}
		addMember(groups.location, account)
		if groups.country != "" {
			addMember("country:"+groups.country, account)
		}
	}
	out.Totals = Totals{UniqueIPs: int64(len(seen)), Accounts: int64(len(out.Accounts)), CountryCount: int64(len(countries))}
	if len(seen) > 0 {
		coverage := float64(out.Quality.Located) / float64(len(seen))
		out.Quality.CoordinateCoverage = &coverage
	}
	for key, n := range counts {
		id := groupNames[key.group]
		out.Memberships[id] = append(out.Memberships[id], Membership{Account: key.account, UniqueIPs: n})
	}
	for id, members := range out.Memberships {
		sort.Slice(members, func(i, j int) bool {
			if members[i].UniqueIPs != members[j].UniqueIPs {
				return members[i].UniqueIPs > members[j].UniqueIPs
			}
			return out.Accounts[members[i].Account] < out.Accounts[members[j].Account]
		})
		if strings.HasPrefix(id, "country:") {
			countries[strings.TrimPrefix(id, "country:")].Accounts = int64(len(members))
		} else {
			locations[id].dto.Accounts = int64(len(members))
		}
	}
	for _, c := range countries {
		out.Countries = append(out.Countries, *c)
	}
	for id, b := range locations {
		b.dto.Name, b.dto.NameRU = optional(b.name), optional(b.nameRU)
		b.dto.Location = groupPosition(b.positions)
		out.Locations = append(out.Locations, b.dto)
		if strings.HasPrefix(id, "city:") || strings.HasPrefix(id, "point:") {
			out.Totals.LocationCount++
		}
	}
	sort.Slice(out.Countries, func(i, j int) bool {
		a, b := out.Countries[i], out.Countries[j]
		if a.UniqueIPs != b.UniqueIPs {
			return a.UniqueIPs > b.UniqueIPs
		}
		return a.ID < b.ID
	})
	sort.Slice(out.Locations, func(i, j int) bool {
		a, b := out.Locations[i], out.Locations[j]
		if a.UniqueIPs != b.UniqueIPs {
			return a.UniqueIPs > b.UniqueIPs
		}
		return a.ID < b.ID
	})
	// The conservative allowance includes capacities, map buckets, pointer values
	// and interned strings. RSS is measured separately from owned object bytes.
	out.OwnedBytes = int64(cap(out.Accounts))*16 + int64(cap(out.Countries))*128 + int64(cap(out.Locations))*224 + 512
	for _, name := range out.Accounts {
		out.OwnedBytes += int64(len(name))
	}
	for _, c := range out.Countries {
		out.OwnedBytes += int64(len(c.ID) + len(c.CountryCode) + len(c.Name) + len(c.NameRU))
	}
	for _, l := range out.Locations {
		out.OwnedBytes += int64(len(l.ID)) + 160
		for _, p := range []*string{l.CountryCode, l.Name, l.NameRU} {
			if p != nil {
				out.OwnedBytes += int64(len(*p))
			}
		}
	}
	for id, m := range out.Memberships {
		out.OwnedBytes += int64(len(id)) + int64(cap(m))*8 + 96
	}
	if out.OwnedBytes > 32<<20 {
		return nil, ErrCapacity
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
