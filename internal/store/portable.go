package store

import (
	"encoding/json"
	"errors"
	"fmt"
)

const portableFormatVersion = 4

// ErrStoreNotEmpty prevents an import from silently merging two independent
// histories. Operators must point the command at a fresh destination store.
var ErrStoreNotEmpty = errors.New("store import requires an empty destination")

// PortableData is the driver-neutral JSON format used by the store export and
// import commands. It deliberately contains only values owned by the panel;
// connection details and other configuration secrets are never exported.
type PortableData struct {
	FormatVersion       int                             `json:"format_version"`
	Sessions            map[string]Session              `json:"sessions"`
	SubpageNonces       map[string]string               `json:"subpage_nonces"`
	Settings            map[string]string               `json:"settings"`
	Journal             map[string][]UpdateJournalEntry `json:"journal"`
	Policies            []StoragePolicy                 `json:"storage_policies,omitempty"`
	Audit               []AuditEntry                    `json:"audit,omitempty"`
	Metrics             map[string][]MetricPoint        `json:"metrics,omitempty"`
	Events              []HistoryEvent                  `json:"events,omitempty"`
	TOTP                TOTPState                       `json:"totp,omitempty"`
	RecoveryCodes       [][]byte                        `json:"totp_recovery_hashes,omitempty"`
	WebAuthnUserHandle  []byte                          `json:"webauthn_user_handle,omitempty"`
	WebAuthnCredentials map[string]WebAuthnCredential   `json:"webauthn_credentials,omitempty"`
	// WebAuthnChallenges is accepted from format v3 backups only. In-flight
	// ceremonies are process-local and are never exported or restored.
	WebAuthnChallenges map[string]WebAuthnChallenge `json:"webauthn_challenges,omitempty"`
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
	return clonePortableData(PortableData{
		FormatVersion:       portableFormatVersion,
		Sessions:            m.sessions,
		SubpageNonces:       m.subpageNonces,
		Settings:            m.settings,
		Journal:             m.journal,
		Policies:            policiesFromMap(m.policies),
		Audit:               m.audit,
		Metrics:             m.metrics,
		Events:              portableEvents(m.events),
		TOTP:                m.totp,
		RecoveryCodes:       recoveryCodeHashes(m.recoveryCodes),
		WebAuthnUserHandle:  append([]byte(nil), m.webauthnUserHandle...),
		WebAuthnCredentials: m.webauthnCredentials,
	})
}

// ImportData atomically initializes an empty memory store from an export.
func (m *Memory) ImportData(data PortableData) error {
	data, err := normalizePortableData(data)
	if err != nil {
		return err
	}
	if m.statePath != "" && (len(data.Metrics) > 0 || len(data.Events) > 0) {
		return errors.New("state file cannot persist imported metric or event history; use a history destination")
	}
	if len(data.Events) > eventCap {
		return fmt.Errorf("memory event history has %d entries (maximum %d)", len(data.Events), eventCap)
	}
	if len(data.Audit) > auditCap {
		return fmt.Errorf("memory audit history has %d entries (maximum %d)", len(data.Audit), auditCap)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.sessions)+len(m.subpageNonces)+len(m.settings)+len(m.journal)+len(m.audit)+len(m.metrics)+len(m.events)+len(m.recoveryCodes)+len(m.webauthnCredentials)+len(m.webauthnChallenges)+len(m.webauthnUserHandle) != 0 || m.totp.Enabled || m.totp.PendingSecret != "" {
		return ErrStoreNotEmpty
	}
	m.sessions = data.Sessions
	m.subpageNonces = data.SubpageNonces
	m.settings = data.Settings
	m.journal = data.Journal
	m.audit = data.Audit
	m.metrics = data.Metrics
	m.events = data.Events
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
	if data.FormatVersion >= 1 && data.FormatVersion < portableFormatVersion {
		data.FormatVersion = portableFormatVersion
	}
	if data.FormatVersion != portableFormatVersion {
		return PortableData{}, fmt.Errorf("unsupported store export format version %d (supported: %d)", data.FormatVersion, portableFormatVersion)
	}
	var err error
	data, err = clonePortableData(data)
	if err != nil {
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
