package geography

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"strings"
)

type cursor struct {
	Snapshot string `json:"snapshot"`
	Kind     string `json:"kind"`
	Filter   string `json:"filter"`
	Weight   int64  `json:"weight"`
	ID       string `json:"id"`
}

func decodeCursor(raw string, want cursor) (cursor, error) {
	if len(raw) > 1024 {
		return cursor{}, ErrBadRequest
	}
	data, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return cursor{}, ErrBadRequest
	}
	d := json.NewDecoder(strings.NewReader(string(data)))
	d.DisallowUnknownFields()
	var c cursor
	if d.Decode(&c) != nil || c.Snapshot != want.Snapshot || c.Kind != want.Kind || c.Filter != want.Filter || c.Weight < 0 || c.ID == "" {
		return cursor{}, ErrBadRequest
	}
	var rest any
	if d.Decode(&rest) != io.EOF {
		return cursor{}, ErrBadRequest
	}
	return c, nil
}
func encodeCursor(c cursor) *string {
	raw, _ := json.Marshal(c)
	v := base64.RawURLEncoding.EncodeToString(raw)
	return &v
}
func pageLimit(limit int) (int, error) {
	if limit == 0 {
		return 50, nil
	}
	if limit < 1 || limit > 100 {
		return 0, ErrBadRequest
	}
	return limit, nil
}

// Locations pages stable countries or places, including coordinate-less service groups.
func (s *Service) Locations(ctx context.Context, q LocationsQuery) (LocationPage, error) {
	if err := ctx.Err(); err != nil {
		return LocationPage{}, err
	}
	limit, err := pageLimit(q.Limit)
	if err != nil {
		return LocationPage{}, err
	}
	if q.Kind == "" {
		q.Kind = "location"
	}
	if q.Kind != "location" && q.Kind != "country" || q.Country != "" && (!validCountry(q.Country) || q.Kind != "location") {
		return LocationPage{}, ErrBadRequest
	}
	entry, err := s.pinned(q.SnapshotID)
	if err != nil {
		return LocationPage{}, err
	}
	if q.Country != "" {
		found := false
		for _, c := range entry.data.Countries {
			found = found || c.CountryCode == q.Country
		}
		if !found {
			return LocationPage{}, ErrNotFound
		}
	}
	binding := cursor{Snapshot: entry.id, Kind: q.Kind, Filter: q.Country}
	var after cursor
	if q.Cursor != "" {
		after, err = decodeCursor(q.Cursor, binding)
		if err != nil {
			return LocationPage{}, err
		}
	}
	out := LocationPage{SnapshotID: entry.id, Items: []any{}}
	passed := q.Cursor == ""
	foundCursor := passed
	var last cursor
	emit := func(id string, weight int64, item any) {
		out.Total++
		if !passed {
			if id == after.ID && weight == after.Weight {
				passed = true
				foundCursor = true
			}
			return
		}
		if len(out.Items) < limit {
			out.Items = append(out.Items, item)
			last = binding
			last.ID, last.Weight = id, weight
		} else if out.NextCursor == nil {
			out.NextCursor = encodeCursor(last)
		}
	}
	if q.Kind == "country" {
		for _, c := range entry.data.Countries {
			emit(c.ID, c.UniqueIPs, c)
		}
	} else {
		for _, l := range entry.data.Locations {
			if q.Country != "" && (l.CountryCode == nil || *l.CountryCode != q.Country) {
				continue
			}
			emit(l.ID, l.UniqueIPs, cloneLocation(l))
		}
	}
	if !foundCursor {
		return LocationPage{}, ErrBadRequest
	}
	if entry.epochs != s.currentEpochs() {
		return LocationPage{}, ErrSnapshotExpired
	}
	return out, ctx.Err()
}

// Users pages interned account memberships from one pinned group.
func (s *Service) Users(ctx context.Context, q UsersQuery) (UserPage, error) {
	if err := ctx.Err(); err != nil {
		return UserPage{}, err
	}
	limit, err := pageLimit(q.Limit)
	if err != nil {
		return UserPage{}, err
	}
	if q.GroupID == "" || len(q.GroupID) > 160 {
		return UserPage{}, ErrBadRequest
	}
	entry, err := s.pinned(q.SnapshotID)
	if err != nil {
		return UserPage{}, err
	}
	members, ok := entry.data.Memberships[q.GroupID]
	if !ok {
		return UserPage{}, ErrNotFound
	}
	binding := cursor{Snapshot: entry.id, Kind: "users", Filter: q.GroupID}
	start := 0
	if q.Cursor != "" {
		c, err := decodeCursor(q.Cursor, binding)
		if err != nil {
			return UserPage{}, err
		}
		found := false
		for i, m := range members {
			if entry.data.Accounts[m.Account] == c.ID && int64(m.UniqueIPs) == c.Weight {
				start = i + 1
				found = true
				break
			}
		}
		if !found {
			return UserPage{}, ErrBadRequest
		}
	}
	end := min(start+limit, len(members))
	out := UserPage{SnapshotID: entry.id, GroupID: q.GroupID, Total: len(members), Items: make([]UserItem, 0, end-start)}
	for _, m := range members[start:end] {
		out.Items = append(out.Items, UserItem{Username: entry.data.Accounts[m.Account], UniqueIPs: int64(m.UniqueIPs)})
	}
	if end < len(members) {
		m := members[end-1]
		binding.ID, binding.Weight = entry.data.Accounts[m.Account], int64(m.UniqueIPs)
		out.NextCursor = encodeCursor(binding)
	}
	if entry.epochs != s.currentEpochs() {
		return UserPage{}, ErrSnapshotExpired
	}
	return out, ctx.Err()
}
