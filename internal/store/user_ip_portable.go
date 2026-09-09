package store

import (
	"errors"
	"sort"
)

func portableMemoryUserIPs(records map[userIPKey]UserIPRecord) []UserIPRecord {
	result := make([]UserIPRecord, 0, len(records))
	for _, r := range records {
		result = append(result, r)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Username != result[j].Username {
			return result[i].Username < result[j].Username
		}
		return result[i].IP < result[j].IP
	})
	return result
}

func portableUserIPCollection(c UserIPCollection) *UserIPCollection {
	if c.BatchID == "" {
		return nil
	}
	return &c
}

func validatePortableUserIPs(data PortableData) error {
	if len(data.UserIPs) > UserIPSQLiteLimit {
		return errors.New("imported IP history exceeds record limit")
	}
	if len(data.UserIPs) > 0 && data.UserIPCollection == nil {
		return errors.New("IP history lacks collection metadata")
	}
	seen := make(map[userIPKey]bool)
	counts := make(map[string]int)
	for _, r := range data.UserIPs {
		if err := validatePortableUserIPRecord(r, data.UserIPCollection); err != nil {
			return err
		}
		key := userIPKey{r.Username, r.IP}
		counts[r.Username]++
		if seen[key] || counts[r.Username] > UserIPPerUserLimit {
			return errors.New("duplicate or excessive imported user IP records")
		}
		seen[key] = true
	}
	if c := data.UserIPCollection; c != nil {
		if err := validatePortableUserIPCollection(*c); err != nil {
			return err
		}
	}
	return nil
}

func validatePortableUserIPRecord(r UserIPRecord, collection *UserIPCollection) error {
	if err := validateUserIPRecord(r); err != nil {
		return err
	}
	if collection == nil {
		return errors.New("IP history lacks collection metadata")
	}
	if r.Last > collection.Through || r.First < collection.Since {
		return errors.New("IP history outside collection bounds")
	}
	return nil
}

func validatePortableUserIPCollection(c UserIPCollection) error {
	if c.BatchID == "" || len(c.BatchID) > 128 || c.Since < 0 || c.Through <= 0 || c.Since > c.Through {
		return errors.New("invalid IP collection metadata")
	}
	return nil
}
