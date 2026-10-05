// Package quotareset serializes manually confirmed and scheduled quota resets.
package quotareset

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"slices"
	"sort"
	"sync"
	"time"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

var (
	ErrBusy         = errors.New("quota operation in progress")
	ErrConfirmation = errors.New("quota confirmation expired or replaced")
	ErrRevision     = errors.New("users configuration changed")
	ErrEmpty        = errors.New("no users")
	ErrClosed       = errors.New("quota worker stopped")
	ErrMissing      = errors.New("quota operation unavailable")
)

// Client is the existing Telemt API surface needed by this operation.
type Client interface {
	Health(context.Context) (telemt.HealthData, error)
	UsersWithRevision(context.Context) ([]telemt.UserInfo, string, error)
	QuotaList(context.Context) (map[string]telemt.QuotaEntry, bool, error)
	ResetQuotaWithRevision(context.Context, string, string) (telemt.QuotaEntry, error)
}

// Confirmation describes the complete, immutable account selection.
type Confirmation struct {
	Token     string    `json:"token"`
	Total     int       `json:"total"`
	ExpiresAt time.Time `json:"expires_at"`
}

// Issue is a safe exception record, without arbitrary upstream error text.
type Issue struct {
	Username string `json:"username"`
	Outcome  string `json:"outcome"`
	Code     string `json:"code"`
}

// Status is a bounded progress projection; only exceptions are paginated.
type Status struct {
	Trigger     string     `json:"trigger,omitempty"`
	ID          string     `json:"id"`
	State       string     `json:"state"`
	Total       int        `json:"total"`
	Processed   int        `json:"processed"`
	Confirmed   int        `json:"confirmed"`
	Rejected    int        `json:"rejected"`
	Unknown     int        `json:"unknown"`
	Remaining   int        `json:"remaining"`
	Reason      string     `json:"reason"`
	StartedAt   time.Time  `json:"started_at"`
	FinishedAt  *time.Time `json:"finished_at,omitempty"`
	Issues      []Issue    `json:"issues"`
	IssuesTotal int        `json:"issues_total"`
	NextOffset  *int       `json:"next_offset,omitempty"`
}

type prepared struct {
	Confirmation
	names    []string
	revision string
}

// Manager keeps only one prepared selection and the current/last result in RAM.
// There is deliberately no retry queue or automatic restart recovery.
type Manager struct {
	mu                       sync.Mutex
	client                   Client
	ctx                      context.Context
	cancel                   context.CancelFunc
	wg                       sync.WaitGroup
	closed, checking, single bool
	prepared                 *prepared
	job                      *Status
	issues                   []Issue
	requestTimeout           time.Duration
	now                      func() time.Time
	onEvent                  func(Status, string, string)
}

// New creates a manager. onEvent is called once at start and once at completion.
func New(client Client, onEvent func(Status, string, string)) *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	return &Manager{client: client, ctx: ctx, cancel: cancel, requestTimeout: 10 * time.Second, now: time.Now, onEvent: onEvent}
}

// Close stops dispatch, waits for the single in-flight request, and never resumes it.
func (m *Manager) Close() { m.mu.Lock(); m.closed = true; m.cancel(); m.mu.Unlock(); m.wg.Wait() }

func (m *Manager) busy() bool {
	return m.checking || m.single || m.job != nil && m.job.State == "running"
}

func (m *Manager) snapshot(ctx context.Context) ([]string, string, error) {
	health, err := m.client.Health(ctx)
	if err != nil {
		return nil, "", err
	}
	if health.ReadOnly {
		return nil, "", &telemt.APIError{Status: 403, Code: "read_only"}
	}
	_, supported, err := m.client.QuotaList(ctx)
	if err != nil {
		return nil, "", err
	}
	if !supported {
		return nil, "", &telemt.APIError{Status: 501, Code: "capability_absent"}
	}
	users, revision, err := m.client.UsersWithRevision(ctx)
	if err != nil {
		return nil, "", err
	}
	if revision == "" {
		return nil, "", &telemt.APIError{Status: 503, Code: "capability_unavailable", Message: "users revision is unavailable"}
	}
	names := make([]string, 0, len(users))
	for _, u := range users {
		if u.Username == "" {
			return nil, "", ErrRevision
		}
		names = append(names, u.Username)
	}
	sort.Strings(names)
	names = slices.Compact(names)
	if len(names) == 0 {
		return names, revision, ErrEmpty
	}
	return names, revision, nil
}

// Prepare reads fresh data without resetting any quota.
func (m *Manager) Prepare(ctx context.Context) (Confirmation, error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return Confirmation{}, ErrClosed
	}
	if m.busy() {
		m.mu.Unlock()
		return Confirmation{}, ErrBusy
	}
	m.checking = true
	m.mu.Unlock()
	defer func() { m.mu.Lock(); m.checking = false; m.mu.Unlock() }()
	names, rev, err := m.snapshot(ctx)
	if err != nil {
		return Confirmation{}, err
	}
	var token [16]byte
	if _, err = rand.Read(token[:]); err != nil {
		return Confirmation{}, err
	}
	p := &prepared{Confirmation: Confirmation{Token: hex.EncodeToString(token[:]), Total: len(names), ExpiresAt: m.now().Add(2 * time.Minute)}, names: names, revision: rev}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Confirmation{}, ErrClosed
	}
	m.prepared = p
	return p.Confirmation, nil
}

// Start accepts a prepared token once; a repeated accepted token returns its
// current result, including after completion, rather than replaying mutations.
func (m *Manager) Start(ctx context.Context, token, actor, ip string) (Status, error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return Status{}, ErrClosed
	}
	if m.job != nil && m.job.ID == token {
		out := m.statusLocked(0)
		m.mu.Unlock()
		return out, nil
	}
	if m.busy() {
		m.mu.Unlock()
		return Status{}, ErrBusy
	}
	p := m.prepared
	if p == nil || token == "" || p.Token != token || !m.now().Before(p.ExpiresAt) {
		m.mu.Unlock()
		return Status{}, ErrConfirmation
	}
	m.checking = true
	m.mu.Unlock()
	names, rev, err := m.snapshot(ctx)
	m.mu.Lock()
	m.checking = false
	if err != nil {
		m.mu.Unlock()
		return Status{}, err
	}
	if m.closed {
		m.mu.Unlock()
		return Status{}, ErrClosed
	}
	if !m.now().Before(p.ExpiresAt) {
		m.mu.Unlock()
		return Status{}, ErrConfirmation
	}
	if rev != p.revision || !slices.Equal(names, p.names) {
		m.prepared = nil
		m.mu.Unlock()
		return Status{}, ErrRevision
	}
	m.prepared = nil
	m.issues = nil
	m.job = &Status{ID: token, State: "running", Total: len(names), StartedAt: m.now().UTC()}
	m.wg.Add(1)
	out := m.statusLocked(0)
	m.mu.Unlock()
	if m.onEvent != nil {
		m.onEvent(out, actor, ip)
	}
	go m.run(names, rev, actor, ip)
	return out, nil
}

func (m *Manager) run(names []string, revision, actor, ip string) Status {
	defer m.wg.Done()
	for _, name := range names {
		if m.ctx.Err() != nil {
			m.mu.Lock()
			m.job.Reason = "server_stopped"
			m.mu.Unlock()
			break
		}
		ctx, cancel := context.WithTimeout(m.ctx, m.requestTimeout)
		_, err := m.client.ResetQuotaWithRevision(ctx, name, revision)
		cancel()
		m.mu.Lock()
		m.job.Processed++
		if err == nil {
			m.job.Confirmed++
		} else {
			issue, stop := classify(name, err)
			m.issues = append(m.issues, issue)
			if issue.Outcome == "unknown" {
				m.job.Unknown++
			} else {
				m.job.Rejected++
			}
			if stop {
				m.job.Reason = issue.Code
				m.mu.Unlock()
				break
			}
		}
		m.mu.Unlock()
	}
	m.mu.Lock()
	now := m.now().UTC()
	m.job.FinishedAt = &now
	m.job.State = "completed"
	if m.job.Reason != "" {
		m.job.State = "stopped"
	}
	out := m.statusLocked(0)
	m.mu.Unlock()
	if m.onEvent != nil {
		m.onEvent(out, actor, ip)
	}
	return out
}

// ExecuteScheduled shares the manual worker and exclusion boundary. reserve
// durably claims a due window before this method can dispatch any mutations.
func (m *Manager) ExecuteScheduled(ctx context.Context, reserve func([]string, string) ([]string, error)) (Status, error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return Status{}, ErrClosed
	}
	if m.busy() {
		m.mu.Unlock()
		return Status{}, ErrBusy
	}
	m.checking = true
	m.mu.Unlock()
	names, revision, err := m.snapshot(ctx)
	m.mu.Lock()
	m.checking = false
	if err != nil && !errors.Is(err, ErrEmpty) {
		m.mu.Unlock()
		return Status{}, err
	}
	if m.closed || ctx.Err() != nil {
		m.mu.Unlock()
		return Status{}, ErrClosed
	}
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		m.mu.Unlock()
		return Status{}, err
	}
	token := hex.EncodeToString(id[:])
	selected, err := reserve(names, token)
	if err != nil {
		m.mu.Unlock()
		return Status{}, err
	}
	if len(selected) == 0 {
		m.mu.Unlock()
		return Status{}, ErrEmpty
	}
	m.prepared = nil
	m.issues = nil
	m.job = &Status{ID: token, Trigger: "schedule", State: "running", Total: len(selected), StartedAt: m.now().UTC()}
	m.wg.Add(1)
	out := m.statusLocked(0)
	// The reserve callback has returned; release the worker lock during I/O.
	m.mu.Unlock()
	if m.onEvent != nil {
		m.onEvent(out, "scheduler", "")
	}
	out = m.run(selected, revision, "scheduler", "")
	return out, nil
}

func classify(name string, err error) (Issue, bool) {
	i := Issue{Username: name, Outcome: "unknown", Code: "reset_unconfirmed"}
	var api *telemt.APIError
	if errors.As(err, &api) {
		// Only known pre-mutation refusals are safe to label rejected. In 3.5.5
		// a 500 can happen after the in-memory counter has already been reset.
		if api.Status == http.StatusNotFound && api.Code == "not_found" {
			i.Outcome = "rejected"
			i.Code = "not_found"
			return i, false
		}
		switch {
		case api.Status == 403 && api.Code == "read_only":
			i.Outcome = "rejected"
			i.Code = "read_only"
		case api.Status == 409 && api.Code == "revision_conflict":
			i.Outcome = "rejected"
			i.Code = "revision_conflict"
		case api.Status == 401 || api.Status == 403:
			i.Outcome = "rejected"
			i.Code = "telemt_auth_failed"
		case api.Status == 404 || api.Status == 405:
			i.Outcome = "rejected"
			i.Code = "capability_absent"
		}
	}
	return i, true
}

// Status returns the current result or the requested matching operation only.
func (m *Manager) Status(id string, offset int) (*Status, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.job == nil {
		if id != "" {
			return nil, ErrMissing
		}
		return nil, nil
	}
	if id != "" && id != m.job.ID {
		return nil, ErrMissing
	}
	out := m.statusLocked(offset)
	return &out, nil
}
func (m *Manager) statusLocked(offset int) Status {
	out := *m.job
	if out.FinishedAt != nil {
		finished := *out.FinishedAt
		out.FinishedAt = &finished
	}
	out.Remaining = out.Total - out.Processed
	out.IssuesTotal = len(m.issues)
	offset = max(0, min(offset, len(m.issues)))
	end := min(offset+50, len(m.issues))
	out.Issues = append([]Issue{}, m.issues[offset:end]...)
	if end < len(m.issues) {
		out.NextOffset = &end
	}
	return out
}

// ResetSingle excludes overlapping individual resets during a batch/check.
func (m *Manager) ResetSingle(ctx context.Context, name string) (telemt.QuotaEntry, error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return telemt.QuotaEntry{}, ErrClosed
	}
	if m.busy() {
		m.mu.Unlock()
		return telemt.QuotaEntry{}, ErrBusy
	}
	m.single = true
	m.mu.Unlock()
	defer func() { m.mu.Lock(); m.single = false; m.mu.Unlock() }()
	return m.client.ResetQuotaWithRevision(ctx, name, "")
}
