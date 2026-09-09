package store

import (
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

// StateStore owns the panel control-plane state. It is always local and must
// remain available when the configured history database is offline.
type StateStore interface {
	StateDurable() bool
	PutSession(Session) error
	GetSession(string) (Session, bool, error)
	TouchSession(string, time.Time) error
	DeleteSession(string) error
	DeleteOtherSessions(string) error
	ListSessions() ([]Session, error)

	GetOrCreateWebAuthnUserHandle([]byte) ([]byte, error)
	ListWebAuthnCredentials() ([]WebAuthnCredential, error)
	GetWebAuthnCredential(string) (WebAuthnCredential, bool, error)
	AddWebAuthnCredential(WebAuthnCredential) error
	DeleteWebAuthnCredential(string) error
	UpdateWebAuthnCredential(WebAuthnCredential, uint32) error
	PutWebAuthnChallenge(WebAuthnChallenge) error
	ConsumeWebAuthnChallenge(string, string, time.Time) (WebAuthnChallenge, error)

	AppendAudit(AuditEntry) error
	ListAudit(int) ([]AuditEntry, error)
	AppendUpdateJournal(UpdateJournalEntry) error
	ListUpdateJournal(string, int) ([]UpdateJournalEntry, error)
	GetSubpageNonce(string) (string, error)
	SetSubpageNonce(string, string) error
	GetSetting(string) (string, bool, error)
	SetSetting(string, string) error
	ListStoragePolicies() ([]StoragePolicy, error)
	ReplaceStoragePolicies([]StoragePolicy) error
	PurgeAudit() error
	Close() error
}

// HistoryStore owns observability history only. SQL implementations may be
// unavailable without affecting StateStore or the administration plane.
type HistoryStore interface {
	UserIPStore
	Driver() string
	Info() Info
	RecordMetric(string, MetricPoint) error
	RecordMetrics([]NamedMetricPoint) error
	MetricRange(string, int64) ([]MetricPoint, error)
	MetricRetention(string) time.Duration
	ApplyUserTrafficSnapshot(UserTrafficSnapshot) (UserTrafficApplyResult, error)
	UserTrafficSummaries() (map[string]UserTrafficSummary, error)
	UserTrafficCollectorState() (UserTrafficCollectorState, error)
	UserTrafficRange(string, int64) ([]UserTrafficPoint, error)
	UserTrafficAggregate(int64, int64) (int64, []UserTrafficPoint, error)
	UserTrafficRanking(int64, int64, bool, int, *UserTrafficRankCursor) ([]UserTrafficRank, error)
	UserTrafficRetention() time.Duration
	DeleteUserHistory(string) error
	ResetUserTraffic() error
	AppendHistoryEvent(HistoryEvent) error
	ListHistoryEvents(HistoryEventFilter) ([]HistoryEvent, error)
	ApplyStoragePolicies([]StoragePolicy) error
	PurgeHistory(StorageCategory) error
	StorageStats() (StorageStats, error)
	Close() error
}

// Composite keeps the control plane and observability history behind the
// existing Store contract while enforcing their separate persistence paths.
type Composite struct {
	policyMu sync.Mutex
	state    StateStore
	history  HistoryStore
}

func NewComposite(state StateStore, history HistoryStore) (*Composite, error) {
	policies, err := state.ListStoragePolicies()
	if err != nil {
		return nil, err
	}
	if err := history.ApplyStoragePolicies(policies); err != nil {
		return nil, err
	}
	return &Composite{state: state, history: history}, nil
}

func (s *Composite) Driver() string { return s.history.Driver() }
func (s *Composite) Info() Info     { return s.history.Info() }
func (s *Composite) StateDurable() bool {
	return s.state.StateDurable()
}

func (s *Composite) PutSession(value Session) error { return s.state.PutSession(value) }
func (s *Composite) GetSession(hash string) (Session, bool, error) {
	return s.state.GetSession(hash)
}
func (s *Composite) TouchSession(hash string, at time.Time) error {
	return s.state.TouchSession(hash, at)
}
func (s *Composite) DeleteSession(hash string) error { return s.state.DeleteSession(hash) }
func (s *Composite) DeleteOtherSessions(keep string) error {
	return s.state.DeleteOtherSessions(keep)
}
func (s *Composite) ListSessions() ([]Session, error) { return s.state.ListSessions() }

func (s *Composite) GetOrCreateWebAuthnUserHandle(candidate []byte) ([]byte, error) {
	return s.state.GetOrCreateWebAuthnUserHandle(candidate)
}
func (s *Composite) ListWebAuthnCredentials() ([]WebAuthnCredential, error) {
	return s.state.ListWebAuthnCredentials()
}
func (s *Composite) GetWebAuthnCredential(id string) (WebAuthnCredential, bool, error) {
	return s.state.GetWebAuthnCredential(id)
}
func (s *Composite) AddWebAuthnCredential(value WebAuthnCredential) error {
	return s.state.AddWebAuthnCredential(value)
}
func (s *Composite) DeleteWebAuthnCredential(id string) error {
	return s.state.DeleteWebAuthnCredential(id)
}
func (s *Composite) UpdateWebAuthnCredential(value WebAuthnCredential, old uint32) error {
	return s.state.UpdateWebAuthnCredential(value, old)
}
func (s *Composite) PutWebAuthnChallenge(value WebAuthnChallenge) error {
	return s.state.PutWebAuthnChallenge(value)
}
func (s *Composite) ConsumeWebAuthnChallenge(hash, kind string, now time.Time) (WebAuthnChallenge, error) {
	return s.state.ConsumeWebAuthnChallenge(hash, kind, now)
}

func (s *Composite) AppendAudit(value AuditEntry) error { return s.state.AppendAudit(value) }
func (s *Composite) ListAudit(limit int) ([]AuditEntry, error) {
	return s.state.ListAudit(limit)
}
func (s *Composite) AppendUpdateJournal(value UpdateJournalEntry) error {
	return s.state.AppendUpdateJournal(value)
}
func (s *Composite) ListUpdateJournal(target string, limit int) ([]UpdateJournalEntry, error) {
	return s.state.ListUpdateJournal(target, limit)
}

func (s *Composite) RecordMetric(name string, point MetricPoint) error {
	return s.history.RecordMetric(name, point)
}
func (s *Composite) RecordMetrics(points []NamedMetricPoint) error {
	return s.history.RecordMetrics(points)
}
func (s *Composite) MetricRange(name string, from int64) ([]MetricPoint, error) {
	return s.history.MetricRange(name, from)
}
func (s *Composite) MetricRetention(name string) time.Duration {
	return s.history.MetricRetention(name)
}
func (s *Composite) ApplyUserTrafficSnapshot(snapshot UserTrafficSnapshot) (UserTrafficApplyResult, error) {
	return s.history.ApplyUserTrafficSnapshot(snapshot)
}
func (s *Composite) UserTrafficSummaries() (map[string]UserTrafficSummary, error) {
	return s.history.UserTrafficSummaries()
}
func (s *Composite) UserTrafficCollectorState() (UserTrafficCollectorState, error) {
	return s.history.UserTrafficCollectorState()
}
func (s *Composite) UserTrafficRange(username string, from int64) ([]UserTrafficPoint, error) {
	return s.history.UserTrafficRange(username, from)
}
func (s *Composite) UserTrafficAggregate(from, to int64) (int64, []UserTrafficPoint, error) {
	return s.history.UserTrafficAggregate(from, to)
}
func (s *Composite) UserTrafficRanking(from, to int64, includeDeleted bool, limit int, cursor *UserTrafficRankCursor) ([]UserTrafficRank, error) {
	return s.history.UserTrafficRanking(from, to, includeDeleted, limit, cursor)
}
func (s *Composite) UserTrafficRetention() time.Duration {
	return s.history.UserTrafficRetention()
}
func (s *Composite) DeleteUserHistory(username string) error {
	return s.history.DeleteUserHistory(username)
}
func (s *Composite) ResetUserTraffic() error {
	return s.history.ResetUserTraffic()
}
func (s *Composite) AppendHistoryEvent(value HistoryEvent) error {
	return s.history.AppendHistoryEvent(value)
}
func (s *Composite) ListHistoryEvents(filter HistoryEventFilter) ([]HistoryEvent, error) {
	return s.history.ListHistoryEvents(filter)
}

func (s *Composite) ListStoragePolicies() ([]StoragePolicy, error) {
	return s.state.ListStoragePolicies()
}

func (s *Composite) ReplaceStoragePolicies(policies []StoragePolicy) error {
	s.policyMu.Lock()
	defer s.policyMu.Unlock()
	if err := ValidateStoragePolicies(policies); err != nil {
		return err
	}
	previous, err := s.state.ListStoragePolicies()
	if err != nil {
		return err
	}
	// Persist the administrator's choice before exposing shorter retention
	// to maintenance or dropping pending observations on disable.
	if err := s.state.ReplaceStoragePolicies(policies); err != nil {
		return err
	}
	if err := s.history.ApplyStoragePolicies(policies); err != nil {
		return errors.Join(err, s.history.ApplyStoragePolicies(previous), s.state.ReplaceStoragePolicies(previous))
	}
	return nil
}

// ApplyStoragePolicies keeps Composite compatible with HistoryStore while
// preserving the state file as the authoritative policy source.
func (s *Composite) ApplyStoragePolicies(policies []StoragePolicy) error {
	return s.ReplaceStoragePolicies(policies)
}

func (s *Composite) PurgeHistory(category StorageCategory) error {
	if category == StorageAudit {
		return s.state.PurgeAudit()
	}
	return s.history.PurgeHistory(category)
}

func (s *Composite) PurgeAudit() error { return s.state.PurgeAudit() }

func (s *Composite) StorageStats() (StorageStats, error) {
	stats, err := s.history.StorageStats()
	if err != nil {
		return StorageStats{}, err
	}
	audit, err := s.state.ListAudit(0)
	if err != nil {
		return StorageStats{}, err
	}
	for i := range stats.Categories {
		if stats.Categories[i].Category == StorageAudit {
			stats.Categories[i].Records = int64(len(audit))
		}
	}
	return stats, nil
}

func (s *Composite) GetSubpageNonce(username string) (string, error) {
	return s.state.GetSubpageNonce(username)
}
func (s *Composite) SetSubpageNonce(username, nonce string) error {
	return s.state.SetSubpageNonce(username, nonce)
}
func (s *Composite) GetSetting(key string) (string, bool, error) {
	return s.state.GetSetting(key)
}
func (s *Composite) SetSetting(key, value string) error {
	return s.state.SetSetting(key, value)
}

func (s *Composite) Close() error {
	return errors.Join(s.history.Close(), s.state.Close())
}

// ExportData creates one operator backup while keeping the state/history
// boundary explicit in the implementation.
func (s *Composite) ExportData() (PortableData, error) {
	statePortable, ok := s.state.(PortableStore)
	if !ok {
		return PortableData{}, errors.New("state store does not support export")
	}
	historyPortable, ok := s.history.(PortableStore)
	if !ok {
		return PortableData{}, errors.New("history store does not support export")
	}
	stateData, err := statePortable.ExportData()
	if err != nil {
		return PortableData{}, err
	}
	historyData, err := historyPortable.ExportData()
	if err != nil {
		return PortableData{}, err
	}
	stateData.Metrics = historyData.Metrics
	stateData.Events = historyData.Events
	stateData.UserTraffic = historyData.UserTraffic
	stateData.UserTrafficBuckets = historyData.UserTrafficBuckets
	stateData.UserTrafficCollector = historyData.UserTrafficCollector
	stateData.UserIPs = historyData.UserIPs
	stateData.UserIPCollection = historyData.UserIPCollection
	stateData.FormatVersion = portableFormatVersion
	return normalizePortableData(stateData)
}

type portableHistoryJSONExporter interface {
	exportJSON(io.Writer, PortableData) error
}

// ExportJSON writes the detached control-plane state followed by one history
// snapshot. The two stores do not share a transaction.
func (s *Composite) ExportJSON(w io.Writer) error {
	statePortable, ok := s.state.(PortableStore)
	if !ok {
		return errors.New("state store does not support export")
	}
	historyPortable, ok := s.history.(portableHistoryJSONExporter)
	if !ok {
		return errors.New("history store does not support streaming export")
	}
	stateData, err := statePortable.ExportData()
	if err != nil {
		return err
	}
	clearPortableHistory(&stateData)
	stateData, err = normalizePortableData(stateData)
	if err != nil {
		return err
	}
	return historyPortable.exportJSON(w, stateData)
}

func clearPortableHistory(data *PortableData) {
	data.Metrics = nil
	data.Events = nil
	data.UserTraffic = nil
	data.UserTrafficBuckets = nil
	data.UserTrafficCollector = nil
	data.UserIPs = nil
	data.UserIPCollection = nil
}

func (m *Memory) exportJSON(w io.Writer, stateData PortableData) error {
	historyData, err := m.ExportData()
	if err != nil {
		return err
	}
	stateData.Metrics = historyData.Metrics
	stateData.Events = historyData.Events
	stateData.UserTraffic = historyData.UserTraffic
	stateData.UserTrafficBuckets = historyData.UserTrafficBuckets
	stateData.UserTrafficCollector = historyData.UserTrafficCollector
	stateData.UserIPs = historyData.UserIPs
	stateData.UserIPCollection = historyData.UserIPCollection
	stateData, err = normalizePortableData(stateData)
	if err != nil {
		return err
	}
	return writePortableJSON(w, stateData)
}

// ImportData restores history first and control-plane state only after the
// optional history destination accepted its part of the backup.
func (s *Composite) ImportData(data PortableData) error {
	data, err := normalizePortableData(data)
	if err != nil {
		return err
	}
	statePortable, ok := s.state.(PortableStore)
	if !ok {
		return errors.New("state store does not support import")
	}
	historyPortable, ok := s.history.(PortableStore)
	if !ok {
		return errors.New("history store does not support import")
	}
	currentState, err := statePortable.ExportData()
	if err != nil {
		return fmt.Errorf("inspect state import destination: %w", err)
	}
	if !portableStateEmpty(currentState) {
		return ErrStoreNotEmpty
	}
	historyEmpty, err := portableHistoryDestinationEmpty(s.history)
	if err != nil {
		return fmt.Errorf("inspect history import destination: %w", err)
	}
	if !historyEmpty {
		return ErrStoreNotEmpty
	}
	stateData := data
	stateData.Metrics = nil
	stateData.Events = nil
	stateData.UserTraffic = nil
	stateData.UserTrafficBuckets = nil
	stateData.UserTrafficCollector = nil
	stateData.UserIPs = nil
	stateData.UserIPCollection = nil
	historyData := PortableData{
		UserIPs:              data.UserIPs,
		UserIPCollection:     data.UserIPCollection,
		FormatVersion:        portableFormatVersion,
		Metrics:              data.Metrics,
		Events:               data.Events,
		UserTraffic:          data.UserTraffic,
		UserTrafficBuckets:   data.UserTrafficBuckets,
		UserTrafficCollector: data.UserTrafficCollector,
	}
	previousPolicies, err := s.state.ListStoragePolicies()
	if err != nil {
		return err
	}
	targetPolicies := previousPolicies
	if len(data.Policies) > 0 {
		targetPolicies = data.Policies
	}
	if err := s.history.ApplyStoragePolicies(targetPolicies); err != nil {
		return errors.Join(err, s.history.ApplyStoragePolicies(previousPolicies))
	}
	if err := historyPortable.ImportData(historyData); err != nil {
		return errors.Join(err, s.history.ApplyStoragePolicies(previousPolicies))
	}
	if err := statePortable.ImportData(stateData); err != nil {
		rollbackErr := rollbackImportedHistory(s.history)
		policyErr := s.history.ApplyStoragePolicies(previousPolicies)
		return errors.Join(err, rollbackErr, policyErr)
	}
	return nil
}

func portableStateEmpty(data PortableData) bool {
	return len(data.Sessions) == 0 &&
		len(data.SubpageNonces) == 0 &&
		len(data.Settings) == 0 &&
		len(data.Journal) == 0 &&
		len(data.Audit) == 0 &&
		len(data.WebAuthnUserHandle) == 0 &&
		len(data.WebAuthnCredentials) == 0
}

func portableHistoryEmpty(data PortableData) bool {
	if len(data.UserIPs) > 0 || data.UserIPCollection != nil {
		return false
	}
	if len(data.Events) != 0 || len(data.UserTraffic) != 0 || len(data.UserTrafficBuckets) != 0 || data.UserTrafficCollector != nil {
		return false
	}
	for _, points := range data.Metrics {
		if len(points) != 0 {
			return false
		}
	}
	return true
}

type historyImportRollback interface {
	rollbackImportedHistory() error
}

type portableHistoryEmptyStore interface {
	portableHistoryEmpty() (bool, error)
}

func portableHistoryDestinationEmpty(history HistoryStore) (bool, error) {
	target, ok := history.(portableHistoryEmptyStore)
	if !ok {
		return false, errors.New("history store cannot inspect portable import destination")
	}
	return target.portableHistoryEmpty()
}

func rollbackImportedHistory(history HistoryStore) error {
	target, ok := history.(historyImportRollback)
	if !ok {
		return errors.New("history store cannot roll back a partial portable import")
	}
	return target.rollbackImportedHistory()
}

var _ Store = (*Composite)(nil)
var _ PortableStore = (*Composite)(nil)
var _ PortableJSONStore = (*Composite)(nil)
