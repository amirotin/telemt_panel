package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

const portableFormatVersion = 7

// ErrStoreNotEmpty prevents an import from silently merging two independent
// histories. Operators must point the command at a fresh destination store.
var ErrStoreNotEmpty = errors.New("store import requires an empty destination")

// PortableData is the driver-neutral JSON format used by the store export and
// import commands. It deliberately contains only values owned by the panel;
// connection details and other configuration secrets are never exported.
type PortableData struct {
	UserIPs              []UserIPRecord                  `json:"user_ip_history,omitempty"`
	UserIPCollection     *UserIPCollection               `json:"user_ip_collection,omitempty"`
	FormatVersion        int                             `json:"format_version"`
	Sessions             map[string]Session              `json:"sessions"`
	SubpageNonces        map[string]string               `json:"subpage_nonces"`
	Settings             map[string]string               `json:"settings"`
	Journal              map[string][]UpdateJournalEntry `json:"journal"`
	Policies             []StoragePolicy                 `json:"storage_policies,omitempty"`
	Audit                []AuditEntry                    `json:"audit,omitempty"`
	Metrics              map[string][]MetricPoint        `json:"metrics,omitempty"`
	Events               []HistoryEvent                  `json:"events,omitempty"`
	UserTraffic          []PortableUserTrafficUser       `json:"user_traffic,omitempty"`
	UserTrafficBuckets   []PortableUserTrafficBucket     `json:"user_traffic_buckets,omitempty"`
	UserTrafficCollector *UserTrafficCollectorState      `json:"user_traffic_collector,omitempty"`
	TOTP                 TOTPState                       `json:"totp,omitempty"`
	RecoveryCodes        [][]byte                        `json:"totp_recovery_hashes,omitempty"`
	WebAuthnUserHandle   []byte                          `json:"webauthn_user_handle,omitempty"`
	WebAuthnCredentials  map[string]WebAuthnCredential   `json:"webauthn_credentials,omitempty"`
	// WebAuthnChallenges is accepted from format v3 backups only. In-flight
	// ceremonies are process-local and are never exported or restored.
	WebAuthnChallenges map[string]WebAuthnChallenge `json:"webauthn_challenges,omitempty"`
}

type PortableUserTrafficUser struct {
	Summary             UserTrafficSummary `json:"summary"`
	LastRawOctets       *int64             `json:"last_raw_octets,omitempty"`
	LastSourceStartedAt *int64             `json:"last_source_started_at,omitempty"`
}

type PortableUserTrafficBucket struct {
	Username string     `json:"username"`
	Tier     MetricTier `json:"tier"`
	TS       int64      `json:"ts"`
	Bytes    int64      `json:"bytes"`
}

// PortableStore is implemented by every built-in store. It is separate from
// Store because portability is an operator CLI capability, not part of the
// request-time persistence contract used by the application.
type PortableStore interface {
	ExportData() (PortableData, error)
	ImportData(PortableData) error
}

// ExportData returns a detached copy of all persisted panel state.
func (m *Memory) ExportData() (PortableData, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.expireUserIPsLocked(time.Now().Unix())
	return clonePortableData(PortableData{
		FormatVersion:        portableFormatVersion,
		UserIPs:              portableMemoryUserIPs(m.userIPs),
		UserIPCollection:     portableUserIPCollection(m.userIPCollection),
		Sessions:             m.sessions,
		SubpageNonces:        m.subpageNonces,
		Settings:             m.settings,
		Journal:              m.journal,
		Policies:             policiesFromMap(m.policies),
		Audit:                m.audit,
		Metrics:              m.metrics,
		Events:               portableEvents(m.events),
		UserTraffic:          portableMemoryUserTraffic(m.userTraffic),
		UserTrafficBuckets:   portableMemoryUserTrafficBuckets(m.userTrafficBuckets),
		UserTrafficCollector: portableMemoryUserTrafficCollector(m.userTrafficCollector, m.hasTrafficCollector),
		TOTP:                 m.totp,
		RecoveryCodes:        recoveryCodeHashes(m.recoveryCodes),
		WebAuthnUserHandle:   append([]byte(nil), m.webauthnUserHandle...),
		WebAuthnCredentials:  m.webauthnCredentials,
	})
}

// ImportData atomically initializes an empty memory store from an export.
func (m *Memory) ImportData(data PortableData) error {
	data, err := normalizePortableData(data)
	if err != nil {
		return err
	}
	if m.statePath != "" && !portableHistoryEmpty(data) {
		return errors.New("state file cannot persist imported metric or event history; use a history destination")
	}
	if len(data.Events) > eventCap {
		return fmt.Errorf("memory event history has %d entries (maximum %d)", len(data.Events), eventCap)
	}
	if len(data.UserIPs) > UserIPMemoryLimit {
		return errors.New("imported IP history exceeds memory limit")
	}
	if len(data.Audit) > auditCap {
		return fmt.Errorf("memory audit history has %d entries (maximum %d)", len(data.Audit), auditCap)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.userIPs) > 0 || m.userIPCollection.BatchID != "" {
		return ErrStoreNotEmpty
	}
	if len(m.sessions)+len(m.subpageNonces)+len(m.settings)+len(m.journal)+len(m.audit)+len(m.metrics)+len(m.events)+len(m.userTraffic)+len(m.userTrafficBuckets)+len(m.recoveryCodes)+len(m.webauthnCredentials)+len(m.webauthnChallenges)+len(m.webauthnUserHandle) != 0 || m.hasTrafficCollector || m.totp.Enabled || m.totp.PendingSecret != "" {
		return ErrStoreNotEmpty
	}
	m.sessions = data.Sessions
	m.subpageNonces = data.SubpageNonces
	m.settings = data.Settings
	m.journal = data.Journal
	m.audit = data.Audit
	m.metrics = data.Metrics
	m.events = data.Events
	m.userIPs = make(map[userIPKey]UserIPRecord, len(data.UserIPs))
	for _, r := range data.UserIPs {
		m.userIPs[userIPKey{r.Username, r.IP}] = r
	}
	if data.UserIPCollection != nil {
		m.userIPCollection = *data.UserIPCollection
	}
	m.userTraffic = memoryUserTrafficFromPortable(data.UserTraffic)
	m.userTrafficBuckets = memoryUserTrafficBucketsFromPortable(data.UserTrafficBuckets)
	if data.UserTrafficCollector != nil {
		m.userTrafficCollector = *data.UserTrafficCollector
		m.hasTrafficCollector = true
		m.pruneUserTrafficBucketsLocked(m.userTrafficCollector.LastSuccessTS)
	}
	m.totp = data.TOTP
	m.recoveryCodes = recoveryCodeMap(data.RecoveryCodes)
	m.webauthnUserHandle = append([]byte(nil), data.WebAuthnUserHandle...)
	m.webauthnCredentials = cloneWebAuthnCredentials(data.WebAuthnCredentials)
	m.webauthnChallenges = make(map[string]WebAuthnChallenge)
	m.totp.RecoveryCodes = len(m.recoveryCodes)
	for i := range m.events {
		m.nextEventID++
		m.events[i].ID = m.nextEventID
	}
	if len(data.Policies) > 0 {
		m.policies = policyMap(data.Policies)
	}
	if err := m.writeStateLocked(); err != nil {
		m.sessions = make(map[string]Session)
		m.subpageNonces = make(map[string]string)
		m.settings = make(map[string]string)
		m.journal = make(map[string][]UpdateJournalEntry)
		m.audit = nil
		m.metrics = make(map[string][]MetricPoint)
		m.events = nil
		m.userIPs = nil
		m.userIPCollection = UserIPCollection{}
		m.userTraffic = make(map[string]memoryUserTraffic)
		m.userTrafficBuckets = make(map[memoryUserTrafficBucketKey]int64)
		m.userTrafficCollector = UserTrafficCollectorState{}
		m.hasTrafficCollector = false
		m.nextEventID = 0
		m.policies = defaultPolicyMap()
		m.totp = TOTPState{LastTimestep: -1}
		m.recoveryCodes = make(map[string]struct{})
		m.webauthnUserHandle = nil
		m.webauthnCredentials = make(map[string]WebAuthnCredential)
		m.webauthnChallenges = make(map[string]WebAuthnChallenge)
		return fmt.Errorf("persist imported memory store: %w", err)
	}
	return nil
}

func normalizePortableData(data PortableData) (PortableData, error) {
	originalVersion := data.FormatVersion
	if originalVersion < 1 || originalVersion > portableFormatVersion {
		return PortableData{}, fmt.Errorf("unsupported store export format version %d (supported: %d)", data.FormatVersion, portableFormatVersion)
	}
	var err error
	data, err = clonePortableData(data)
	if err != nil {
		return PortableData{}, err
	}
	if originalVersion < 5 {
		if err := migratePortableUserTraffic(&data); err != nil {
			return PortableData{}, err
		}
	}
	data.FormatVersion = portableFormatVersion
	if err := validatePortableMetrics(data.Metrics); err != nil {
		return PortableData{}, err
	}
	if originalVersion < 6 {
		data.Policies = upgradeUserIPPolicies(data.Policies)
	}
	if err := validatePortableUserIPs(data); err != nil {
		return PortableData{}, err
	}
	if len(data.Policies) > 0 {
		if err := ValidateStoragePolicies(data.Policies); err != nil {
			return PortableData{}, fmt.Errorf("invalid storage policies: %w", err)
		}
	}
	if err := validatePortableTOTP(data.TOTP, data.RecoveryCodes); err != nil {
		return PortableData{}, err
	}
	if err := validatePortableWebAuthn(data.WebAuthnUserHandle, data.WebAuthnCredentials, data.WebAuthnChallenges); err != nil {
		return PortableData{}, err
	}
	data.WebAuthnChallenges = nil
	data.TOTP.RecoveryCodes = len(data.RecoveryCodes)
	for target, entries := range data.Journal {
		if len(entries) > journalCap {
			return PortableData{}, fmt.Errorf("update journal %q has %d entries (maximum %d)", target, len(entries), journalCap)
		}
	}
	for idHash, session := range data.Sessions {
		if idHash == "" || session.IDHash != idHash {
			return PortableData{}, fmt.Errorf("session map key %q does not match id_hash %q", idHash, session.IDHash)
		}
	}
	for target, entries := range data.Journal {
		for _, entry := range entries {
			if target == "" || entry.Target != target {
				return PortableData{}, fmt.Errorf("journal map key %q does not match entry target %q", target, entry.Target)
			}
		}
	}
	for i := range data.Events {
		if data.Events[i].Category == "" {
			data.Events[i].Category = StorageEvents
		}
		if _, ok := defaultPolicyMap()[data.Events[i].Category]; !ok {
			return PortableData{}, fmt.Errorf("history event has unknown category %q", data.Events[i].Category)
		}
	}
	if err := validatePortableUserTraffic(data); err != nil {
		return PortableData{}, err
	}
	if _, reserved := data.Settings["migration.memory_mirror_imported"]; reserved {
		return PortableData{}, errors.New("store export contains a reserved migration marker")
	}
	return data, nil
}

func clonePortableData(data PortableData) (PortableData, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return PortableData{}, fmt.Errorf("encode store export: %w", err)
	}
	var clone PortableData
	if err := json.Unmarshal(raw, &clone); err != nil {
		return PortableData{}, fmt.Errorf("clone store export: %w", err)
	}
	if clone.Sessions == nil {
		clone.Sessions = make(map[string]Session)
	}
	if clone.SubpageNonces == nil {
		clone.SubpageNonces = make(map[string]string)
	}
	if clone.Settings == nil {
		clone.Settings = make(map[string]string)
	}
	if clone.Journal == nil {
		clone.Journal = make(map[string][]UpdateJournalEntry)
	}
	if clone.Metrics == nil {
		clone.Metrics = make(map[string][]MetricPoint)
	}
	if clone.WebAuthnCredentials == nil {
		clone.WebAuthnCredentials = make(map[string]WebAuthnCredential)
	}
	if clone.WebAuthnChallenges == nil {
		clone.WebAuthnChallenges = make(map[string]WebAuthnChallenge)
	}
	return clone, nil
}

func portableMemoryUserTraffic(values map[string]memoryUserTraffic) []PortableUserTrafficUser {
	usernames := make([]string, 0, len(values))
	for username := range values {
		usernames = append(usernames, username)
	}
	sort.Strings(usernames)
	result := make([]PortableUserTrafficUser, 0, len(usernames))
	for _, username := range usernames {
		value := values[username]
		item := PortableUserTrafficUser{Summary: value.summary}
		if value.hasBaseline {
			raw, source := value.lastRaw, value.lastSourceStart
			item.LastRawOctets, item.LastSourceStartedAt = &raw, &source
		}
		result = append(result, item)
	}
	return result
}

func portableMemoryUserTrafficBuckets(values map[memoryUserTrafficBucketKey]int64) []PortableUserTrafficBucket {
	result := make([]PortableUserTrafficBucket, 0, len(values))
	for key, bytes := range values {
		result = append(result, PortableUserTrafficBucket{Username: key.username, Tier: MetricTierQuarter, TS: key.ts, Bytes: bytes})
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Username != result[j].Username {
			return result[i].Username < result[j].Username
		}
		return result[i].TS < result[j].TS
	})
	return result
}

func portableMemoryUserTrafficCollector(value UserTrafficCollectorState, present bool) *UserTrafficCollectorState {
	if !present {
		return nil
	}
	copy := value
	return &copy
}

func memoryUserTrafficFromPortable(values []PortableUserTrafficUser) map[string]memoryUserTraffic {
	result := make(map[string]memoryUserTraffic, len(values))
	for _, item := range values {
		value := memoryUserTraffic{summary: item.Summary}
		if item.LastRawOctets != nil && item.LastSourceStartedAt != nil {
			value.lastRaw = *item.LastRawOctets
			value.lastSourceStart = *item.LastSourceStartedAt
			value.hasBaseline = true
		}
		result[item.Summary.Username] = value
	}
	return result
}

func memoryUserTrafficBucketsFromPortable(values []PortableUserTrafficBucket) map[memoryUserTrafficBucketKey]int64 {
	result := make(map[memoryUserTrafficBucketKey]int64)
	for _, item := range values {
		if item.Tier != MetricTierQuarter {
			continue
		}
		result[memoryUserTrafficBucketKey{username: item.Username, ts: item.TS}] = item.Bytes
	}
	return result
}

func validatePortableUserTraffic(data PortableData) error {
	users := make(map[string]struct{}, len(data.UserTraffic))
	for _, item := range data.UserTraffic {
		summary := item.Summary
		if summary.Username == "" || summary.ObservedTotalBytes < 0 || summary.CurrentMonthBytes < 0 || summary.ObservedSinceEpochSecs <= 0 ||
			(summary.Continuity != UserTrafficNormal && summary.Continuity != UserTrafficPartial) {
			return fmt.Errorf("invalid portable user traffic entry %q", summary.Username)
		}
		if _, duplicate := users[summary.Username]; duplicate {
			return fmt.Errorf("duplicate portable user traffic entry %q", summary.Username)
		}
		users[summary.Username] = struct{}{}
		if (item.LastRawOctets == nil) != (item.LastSourceStartedAt == nil) ||
			(item.LastRawOctets != nil && (*item.LastRawOctets < 0 || *item.LastSourceStartedAt <= 0)) {
			return fmt.Errorf("invalid portable user traffic baseline %q", summary.Username)
		}
	}
	seenBuckets := make(map[string]struct{}, len(data.UserTrafficBuckets))
	for _, bucket := range data.UserTrafficBuckets {
		if _, ok := users[bucket.Username]; !ok || bucket.TS <= 0 || bucket.Bytes <= 0 ||
			(bucket.Tier != MetricTierQuarter && bucket.Tier != MetricTierHour && bucket.Tier != MetricTierDay) {
			return fmt.Errorf("invalid portable user traffic bucket for %q", bucket.Username)
		}
		key := fmt.Sprintf("%s\x00%s\x00%d", bucket.Username, bucket.Tier, bucket.TS)
		if _, duplicate := seenBuckets[key]; duplicate {
			return fmt.Errorf("duplicate portable user traffic bucket for %q", bucket.Username)
		}
		seenBuckets[key] = struct{}{}
	}
	if state := data.UserTrafficCollector; state != nil {
		if state.LastSuccessTS <= 0 || state.SourceStartedAt <= 0 ||
			(state.SourceState != UserTrafficCollecting && state.SourceState != UserTrafficPaused && state.SourceState != UserTrafficUnavailable) ||
			(state.Continuity != UserTrafficNormal && state.Continuity != UserTrafficPartial) {
			return errors.New("invalid portable user traffic collector")
		}
	}
	return nil
}

func migratePortableUserTraffic(data *PortableData) error {
	type legacyUser struct {
		quarter []MetricPoint
		hour    []MetricPoint
	}
	legacy := make(map[string]*legacyUser)
	for name, points := range data.Metrics {
		username, ok := portableTrafficUsername(name)
		if !ok {
			continue
		}
		entry := legacy[username]
		if entry == nil {
			entry = &legacyUser{}
			legacy[username] = entry
		}
		for _, point := range points {
			switch point.Tier {
			case MetricTierQuarter:
				entry.quarter = append(entry.quarter, point)
			case MetricTierHour:
				entry.hour = append(entry.hour, point)
			}
		}
		delete(data.Metrics, name)
	}
	monthKey := utcMonthKey(time.Now().Unix())
	for username, entry := range legacy {
		selected := entry.hour
		if len(selected) == 0 {
			selected = entry.quarter
		}
		if len(selected) == 0 {
			continue
		}
		summary := UserTrafficSummary{Username: username, MonthKey: monthKey, Continuity: UserTrafficNormal}
		for _, point := range selected {
			bytes, err := portableLegacyTrafficBytes(point.Value)
			if err != nil || bytes > math.MaxInt64-summary.ObservedTotalBytes {
				return fmt.Errorf("migrate portable user traffic %q: invalid bytes", username)
			}
			summary.ObservedTotalBytes += bytes
			if summary.ObservedSinceEpochSecs == 0 || point.TS < summary.ObservedSinceEpochSecs {
				summary.ObservedSinceEpochSecs = point.TS
			}
			if point.TS > summary.LastActivityEpochSecs {
				summary.LastActivityEpochSecs = point.TS
			}
			if utcMonthKey(point.TS) == monthKey {
				summary.CurrentMonthBytes += bytes
			}
		}
		data.UserTraffic = append(data.UserTraffic, PortableUserTrafficUser{Summary: summary})
		for _, tierPoints := range []struct {
			tier   MetricTier
			points []MetricPoint
		}{{MetricTierQuarter, entry.quarter}, {MetricTierHour, entry.hour}} {
			for _, point := range tierPoints.points {
				bytes, err := portableLegacyTrafficBytes(point.Value)
				if err != nil {
					return fmt.Errorf("migrate portable user traffic %q: %w", username, err)
				}
				if bytes > 0 {
					data.UserTrafficBuckets = append(data.UserTrafficBuckets, PortableUserTrafficBucket{Username: username, Tier: tierPoints.tier, TS: point.TS, Bytes: bytes})
				}
			}
		}
		dayBytes := make(map[int64]int64)
		for _, point := range entry.hour {
			bytes, _ := portableLegacyTrafficBytes(point.Value)
			day := point.TS - point.TS%86400
			if bytes > math.MaxInt64-dayBytes[day] {
				return fmt.Errorf("migrate portable user traffic %q: daily bytes overflow", username)
			}
			dayBytes[day] += bytes
		}
		for day, bytes := range dayBytes {
			if bytes > 0 {
				data.UserTrafficBuckets = append(data.UserTrafficBuckets, PortableUserTrafficBucket{Username: username, Tier: MetricTierDay, TS: day, Bytes: bytes})
			}
		}
	}
	sort.Slice(data.UserTraffic, func(i, j int) bool {
		return data.UserTraffic[i].Summary.Username < data.UserTraffic[j].Summary.Username
	})
	sort.Slice(data.UserTrafficBuckets, func(i, j int) bool {
		a, b := data.UserTrafficBuckets[i], data.UserTrafficBuckets[j]
		if a.Username != b.Username {
			return a.Username < b.Username
		}
		if a.Tier != b.Tier {
			return a.Tier < b.Tier
		}
		return a.TS < b.TS
	})
	return nil
}

func portableTrafficUsername(name string) (string, bool) {
	if !strings.HasPrefix(name, "user.") || !strings.HasSuffix(name, ".traffic") {
		return "", false
	}
	username := strings.TrimSuffix(strings.TrimPrefix(name, "user."), ".traffic")
	return username, username != ""
}

func portableLegacyTrafficBytes(value float64) (int64, error) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, errors.New("non-finite bytes")
	}
	converted := int64(value)
	if converted < 0 || float64(converted) != value {
		return 0, errors.New("bytes are not an exact non-negative int64")
	}
	return converted, nil
}

// portableEvents strips store-local sequence numbers. Import assigns fresh
// IDs while preserving timestamps and semantic ordering across drivers.
func portableEvents(events []HistoryEvent) []HistoryEvent {
	if len(events) == 0 {
		return nil
	}
	out := make([]HistoryEvent, len(events))
	copy(out, events)
	for i := range out {
		out[i].ID = 0
		out[i].Attributes = cloneStringMap(out[i].Attributes)
	}
	return out
}
