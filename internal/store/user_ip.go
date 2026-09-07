package store

import (
	"errors"
	"math"
	"net/netip"
	"sort"
	"strings"
	"time"
)

const (
	UserIPPerUserLimit = 256
	UserIPMemoryLimit  = 20000
	UserIPSQLiteLimit  = 100000
	UserIPBatchLimit   = 20000
)

// UserIPRecord describes panel observations, not connection or packet events.
type UserIPRecord struct {
	Username     string `json:"username"`
	IP           string `json:"ip"`
	Family       int    `json:"family"`
	First        int64  `json:"first_observed_at"`
	Last         int64  `json:"last_observed_at"`
	Observations int64  `json:"observations"`
	LastActive   int64  `json:"last_active_observed_at,omitempty"`
	Source       int    `json:"last_source_mask"`
}

// UserIPCollection is durable collection metadata, never a live presence flag.
type UserIPCollection struct {
	BatchID string `json:"batch_id,omitempty"`
	Since   int64  `json:"observed_since"`
	Through int64  `json:"collected_through"`
	Limited bool   `json:"history_limited"`
	Gap     bool   `json:"collection_gap"`
}

type UserIPBatch struct {
	ID      string
	Through int64
	Records []UserIPRecord
	Limited bool
	Gap     bool
}

type UserIPQuery struct {
	Username string
	Now      int64
	From     int64
	Family   int
	Search   string
	Limit    int
	Before   int64
	AfterIP  string
}

type UserIPPage struct {
	Items   []UserIPRecord `json:"items"`
	Total   int64          `json:"total"`
	Matched int64          `json:"matched"`
	New     int64          `json:"new"`
	HasMore bool           `json:"has_more"`
}

type UserIPStore interface {
	PruneUserIPHistory(now int64) error
	ApplyUserIPBatch(UserIPBatch) error
	UserIPHistory(UserIPQuery) (UserIPPage, error)
	UserIPSummaries(from, now int64) (map[string]int64, error)
	UserIPCollectionState() (UserIPCollection, error)
	ResetUserIPHistory(username string) error
	UserIPRetention() time.Duration
}

// UserIPSummary is intentionally small enough for the users index and SSE.
type UserIPSummary struct {
	Unique  int64 `json:"unique"`
	From    int64 `json:"from"`
	Through int64 `json:"collected_through"`
	Limited bool  `json:"history_limited"`
	Gap     bool  `json:"collection_gap"`
}

func UserIPSummaryMap(st HistoryStore, now int64) (map[string]UserIPSummary, error) {
	c, err := st.UserIPCollectionState()
	if err != nil {
		return nil, err
	}
	if c.Through == 0 {
		return nil, nil
	}
	from := max(now-30*86400, now-int64(st.UserIPRetention()/time.Second))
	counts, err := st.UserIPSummaries(from, now)
	if err != nil {
		return nil, err
	}
	result := make(map[string]UserIPSummary, len(counts))
	for user, n := range counts {
		result[user] = UserIPSummary{Unique: n, From: from, Through: c.Through, Limited: c.Limited, Gap: c.Gap}
	}
	return result, nil
}

// NormalizeUserIP preserves individual IPv6 addresses and unmaps IPv4 aliases.
func NormalizeUserIP(raw string) (string, int, error) {
	ip, err := netip.ParseAddr(raw)
	if err != nil || ip.Zone() != "" || ip.IsUnspecified() || ip.IsMulticast() {
		return "", 0, errors.New("invalid observed IP address")
	}
	ip = ip.Unmap()
	if ip.IsUnspecified() || ip.IsMulticast() {
		return "", 0, errors.New("invalid observed IP address")
	}
	family := 6
	if ip.Is4() {
		family = 4
	}
	return ip.String(), family, nil
}

func validateUserIPRecord(r UserIPRecord) error {
	ip, family, err := NormalizeUserIP(r.IP)
	if err != nil || ip != r.IP || family != r.Family || r.Username == "" || len(r.Username) > 256 ||
		r.First <= 0 || r.Last < r.First || r.Observations < 1 || r.Source < 1 || r.Source > 3 ||
		r.LastActive < 0 || (r.LastActive != 0 && (r.LastActive < r.First || r.LastActive > r.Last)) {
		return errors.New("invalid user IP record")
	}
	return nil
}

func validateUserIPBatch(b UserIPBatch) error {
	if b.ID == "" || len(b.ID) > 128 || b.Through <= 0 || len(b.Records) > UserIPBatchLimit {
		return errors.New("invalid user IP batch")
	}
	seen := make(map[userIPKey]bool, len(b.Records))
	for _, r := range b.Records {
		if err := validateUserIPRecord(r); err != nil {
			return err
		}
		key := userIPKey{r.Username, r.IP}
		if r.Last > b.Through || seen[key] {
			return errors.New("invalid user IP batch records")
		}
		seen[key] = true
	}
	return nil
}

func validateUserIPQuery(q UserIPQuery) error {
	if q.Username == "" || q.Now <= 0 || q.From < 0 || q.From > q.Now || q.Limit < 1 || q.Limit > 200 ||
		(q.Family != 0 && q.Family != 4 && q.Family != 6) || len(q.Search) > 64 || q.Before < 0 {
		return errors.New("invalid user IP query")
	}
	return nil
}

func nextUserIPCollection(old UserIPCollection, b UserIPBatch) UserIPCollection {
	if old.Since == 0 {
		old.Since = b.Through
	}
	for _, r := range b.Records {
		old.Since = min(old.Since, r.First)
	}
	old.Through, old.BatchID = b.Through, b.ID
	old.Limited = old.Limited || b.Limited
	old.Gap = old.Gap || b.Gap
	return old
}

func MergeUserIPRecord(old, next UserIPRecord) UserIPRecord {
	if old.Observations == 0 {
		return next
	}
	old.First = min(old.First, next.First)
	old.LastActive = max(old.LastActive, next.LastActive)
	if next.Last >= old.Last {
		old.Last, old.Source = next.Last, next.Source
	}
	if old.Observations > math.MaxInt64-next.Observations {
		old.Observations = math.MaxInt64
	} else {
		old.Observations += next.Observations
	}
	return old
}

type userIPKey struct{ username, ip string }

func (m *Memory) UserIPRetention() time.Duration { return 24 * time.Hour }

func (m *Memory) expireUserIPsLocked(now int64) {
	cutoff := now - int64(m.UserIPRetention()/time.Second)
	for key, r := range m.userIPs {
		if r.Last < cutoff {
			delete(m.userIPs, key)
		}
	}
}

func (m *Memory) PruneUserIPHistory(now int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.expireUserIPsLocked(now)
	return nil
}

func (s *Composite) PruneUserIPHistory(now int64) error { return s.history.PruneUserIPHistory(now) }

func (m *Memory) ApplyUserIPBatch(b UserIPBatch) error {
	if err := validateUserIPBatch(b); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if b.ID == m.userIPCollection.BatchID {
		return nil
	}
	if b.Through <= m.userIPCollection.Through {
		return errors.New("stale user IP batch")
	}
	if m.userIPs == nil {
		m.userIPs = make(map[userIPKey]UserIPRecord)
	}
	m.expireUserIPsLocked(b.Through)
	for _, r := range b.Records {
		key := userIPKey{r.Username, r.IP}
		m.userIPs[key] = MergeUserIPRecord(m.userIPs[key], r)
	}
	m.userIPCollection = nextUserIPCollection(m.userIPCollection, b)
	m.pruneUserIPsLocked(b.Through)
	return nil
}

func (m *Memory) pruneUserIPsLocked(now int64) {
	rows := make([]UserIPRecord, 0, len(m.userIPs))
	for key, r := range m.userIPs {
		if r.Last < now-int64(m.UserIPRetention()/time.Second) {
			delete(m.userIPs, key)
		} else {
			rows = append(rows, r)
		}
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Last != rows[j].Last {
			return rows[i].Last > rows[j].Last
		}
		if rows[i].Username != rows[j].Username {
			return rows[i].Username > rows[j].Username
		}
		return rows[i].IP > rows[j].IP
	})
	counts := make(map[string]int)
	kept := 0
	for _, r := range rows {
		if counts[r.Username] >= UserIPPerUserLimit || kept >= UserIPMemoryLimit {
			delete(m.userIPs, userIPKey{r.Username, r.IP})
			m.userIPCollection.Limited = true
		} else {
			counts[r.Username]++
			kept++
		}
	}
}

func (m *Memory) UserIPHistory(q UserIPQuery) (UserIPPage, error) {
	page := UserIPPage{Items: []UserIPRecord{}}
	if err := validateUserIPQuery(q); err != nil {
		return page, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	from := max(q.From, q.Now-int64(m.UserIPRetention()/time.Second))
	for _, r := range m.userIPs {
		if r.Username != q.Username || r.Last < from {
			continue
		}
		page.Total++
		if r.First >= q.From {
			page.New++
		}
		if q.Family != 0 && q.Family != r.Family || !strings.Contains(r.IP, strings.ToLower(q.Search)) {
			continue
		}
		page.Matched++
		if q.Before != 0 && (r.Last > q.Before || r.Last == q.Before && r.IP <= q.AfterIP) {
			continue
		}
		page.Items = append(page.Items, r)
	}
	sort.Slice(page.Items, func(i, j int) bool {
		if page.Items[i].Last != page.Items[j].Last {
			return page.Items[i].Last > page.Items[j].Last
		}
		return page.Items[i].IP < page.Items[j].IP
	})
	page.HasMore = len(page.Items) > q.Limit
	if page.HasMore {
		page.Items = page.Items[:q.Limit]
	}
	return page, nil
}

func (m *Memory) UserIPSummaries(from, now int64) (map[string]int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	from = max(from, now-int64(m.UserIPRetention()/time.Second))
	result := make(map[string]int64)
	for _, r := range m.userIPs {
		if r.Last >= from {
			result[r.Username]++
		}
	}
	return result, nil
}

func (m *Memory) UserIPCollectionState() (UserIPCollection, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.userIPCollection, nil
}

func (m *Memory) ResetUserIPHistory(username string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for key := range m.userIPs {
		if username == "" || key.username == username {
			delete(m.userIPs, key)
		}
	}
	// Retain the watermark so a committed batch cannot resurrect reset rows.
	if username == "" {
		m.userIPCollection.Since = 0
		m.userIPCollection.Limited = false
		m.userIPCollection.Gap = false
	}
	return nil
}

func (s *Composite) ApplyUserIPBatch(b UserIPBatch) error { return s.history.ApplyUserIPBatch(b) }
func (s *Composite) UserIPHistory(q UserIPQuery) (UserIPPage, error) {
	return s.history.UserIPHistory(q)
}
func (s *Composite) UserIPSummaries(from, now int64) (map[string]int64, error) {
	return s.history.UserIPSummaries(from, now)
}
func (s *Composite) UserIPCollectionState() (UserIPCollection, error) {
	return s.history.UserIPCollectionState()
}
func (s *Composite) ResetUserIPHistory(username string) error {
	return s.history.ResetUserIPHistory(username)
}
func (s *Composite) UserIPRetention() time.Duration { return s.history.UserIPRetention() }
