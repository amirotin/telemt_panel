package store

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"math"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type storeFactory func(*testing.T) Store

// runStoreContract is the single behavioral suite for every backend. Driver-
// specific tests cover SQL syntax and migrations; this suite protects the
// semantics consumed by auth, hub, journal and settings code.
func runStoreContract(t *testing.T, factory storeFactory) Store {
	t.Helper()
	st := factory(t)
	t.Cleanup(func() {
		if err := st.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	prefix := fmt.Sprintf("contract-%d", time.Now().UnixNano())
	now := time.Now().UTC().Truncate(time.Second)

	t.Run("sessions", func(t *testing.T) {
		first := Session{IDHash: prefix + "-a", Created: now, LastSeen: now, IP: "127.0.0.1", UserAgentLabel: "test", AuthMethod: "password"}
		second := Session{IDHash: prefix + "-b", Created: now.Add(time.Second), LastSeen: now.Add(time.Second), IP: "::1", UserAgentLabel: "test-2", AuthMethod: "password"}
		if err := st.PutSession(first); err != nil {
			t.Fatal(err)
		}
		if err := st.PutSession(second); err != nil {
			t.Fatal(err)
		}
		if err := st.TouchSession(first.IDHash, now.Add(time.Minute)); err != nil {
			t.Fatal(err)
		}
		got, ok, err := st.GetSession(first.IDHash)
		if err != nil || !ok || !got.LastSeen.Equal(now.Add(time.Minute)) {
			t.Fatalf("GetSession = %+v, %v, %v", got, ok, err)
		}
		if err := st.DeleteOtherSessions(second.IDHash); err != nil {
			t.Fatal(err)
		}
		if _, ok, err := st.GetSession(first.IDHash); err != nil || ok {
			t.Fatalf("first session survived: ok=%v err=%v", ok, err)
		}
		if err := st.DeleteSession(second.IDHash); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("totp_atomic_state", func(t *testing.T) {
		recovery := make([][]byte, 10)
		for i := range recovery {
			hash := sha256.Sum256([]byte(fmt.Sprintf("%s-recovery-%d", prefix, i)))
			recovery[i] = append([]byte(nil), hash[:]...)
		}
		state, err := st.GetTOTPState()
		if err != nil || state.Enabled || state.RecoveryCodes != 0 {
			t.Fatalf("initial TOTP state = %+v, %v", state, err)
		}
		if err := st.BeginTOTPSetup("expired-secret", now.Add(-time.Second)); err != nil {
			t.Fatal(err)
		}
		if err := st.EnableTOTP("expired-secret", now, recovery); !errors.Is(err, ErrTOTPSetupInvalid) {
			t.Fatalf("expired setup error = %v", err)
		}
		if err := st.BeginTOTPSetup("active-secret", now.Add(time.Minute)); err != nil {
			t.Fatal(err)
		}
		if err := st.EnableTOTP("active-secret", now, recovery); err != nil {
			t.Fatal(err)
		}
		state, err = st.GetTOTPState()
		if err != nil || !state.Enabled || state.Secret != "active-secret" || state.PendingSecret != "" || state.LastTimestep != -1 || state.RecoveryCodes != 10 {
			t.Fatalf("enabled TOTP state = %+v, %v", state, err)
		}
		if err := st.BeginTOTPSetup("replacement", now.Add(time.Minute)); !errors.Is(err, ErrTOTPAlreadyEnabled) {
			t.Fatalf("setup while enabled error = %v", err)
		}
		if err := st.AcceptTOTPTimestep(101); err != nil {
			t.Fatal(err)
		}
		if err := st.AcceptTOTPTimestep(101); !errors.Is(err, ErrTOTPReplay) {
			t.Fatalf("replayed timestep error = %v", err)
		}
		if err := st.ConsumeRecoveryCode(recovery[0]); err != nil {
			t.Fatal(err)
		}
		if err := st.ConsumeRecoveryCode(recovery[0]); !errors.Is(err, ErrRecoveryCode) {
			t.Fatalf("reused recovery code error = %v", err)
		}

		var successes atomic.Int32
		errs := make(chan error, 2)
		var wg sync.WaitGroup
		for range 2 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				err := st.ConsumeRecoveryCode(recovery[1])
				if err == nil {
					successes.Add(1)
					return
				}
				if !errors.Is(err, ErrRecoveryCode) {
					errs <- err
				}
			}()
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			t.Fatal(err)
		}
		if successes.Load() != 1 {
			t.Fatalf("concurrent recovery successes = %d, want 1", successes.Load())
		}
		state, err = st.GetTOTPState()
		if err != nil || state.RecoveryCodes != 8 {
			t.Fatalf("recovery count after consume = %+v, %v", state, err)
		}
		if err := st.DisableTOTP(); err != nil {
			t.Fatal(err)
		}
		state, err = st.GetTOTPState()
		if err != nil || state.Enabled || state.Secret != "" || state.RecoveryCodes != 0 {
			t.Fatalf("disabled TOTP state = %+v, %v", state, err)
		}
	})

	t.Run("webauthn_atomic_state", func(t *testing.T) {
		handleCandidate := make([]byte, webAuthnUserHandleBytes)
		for i := range handleCandidate {
			handleCandidate[i] = byte(i + 1)
		}
		otherCandidate := make([]byte, webAuthnUserHandleBytes)
		for i := range otherCandidate {
			otherCandidate[i] = 0xff
		}
		type handleResult struct {
			handle []byte
			err    error
		}
		handles := make(chan handleResult, 2)
		var handleWG sync.WaitGroup
		for _, candidate := range [][]byte{handleCandidate, otherCandidate} {
			handleWG.Add(1)
			go func() {
				defer handleWG.Done()
				handle, err := st.GetOrCreateWebAuthnUserHandle(candidate)
				handles <- handleResult{handle: handle, err: err}
			}()
		}
		handleWG.Wait()
		close(handles)
		var installed []byte
		for result := range handles {
			if result.err != nil {
				t.Fatal(result.err)
			}
			if installed == nil {
				installed = result.handle
			} else if string(installed) != string(result.handle) {
				t.Fatalf("concurrent WebAuthn handles differ: %x / %x", installed, result.handle)
			}
		}
		handle, err := st.GetOrCreateWebAuthnUserHandle(handleCandidate)
		if err != nil || string(handle) != string(installed) {
			t.Fatalf("stable WebAuthn user handle = %x, %v", handle, err)
		}

		credentialID := base64.RawURLEncoding.EncodeToString([]byte(prefix + "-credential"))
		credential := WebAuthnCredential{
			ID: credentialID, Name: "Laptop", CredentialData: []byte(`{"id":"credential"}`),
			SignCount: 4, Created: now,
		}
		if err := st.AddWebAuthnCredential(credential); err != nil {
			t.Fatal(err)
		}
		if err := st.AddWebAuthnCredential(credential); !errors.Is(err, ErrWebAuthnCredentialExists) {
			t.Fatalf("duplicate credential error = %v", err)
		}
		got, ok, err := st.GetWebAuthnCredential(credential.ID)
		if err != nil || !ok || got.Name != "Laptop" || got.SignCount != 4 {
			t.Fatalf("GetWebAuthnCredential = %+v, %v, %v", got, ok, err)
		}
		got.Name = "Security key"
		got.SignCount = 5
		got.LastUsed = now.Add(time.Minute)
		var updates atomic.Int32
		errs := make(chan error, 2)
		var wg sync.WaitGroup
		for range 2 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if err := st.UpdateWebAuthnCredential(got, 4); err == nil {
					updates.Add(1)
				} else if !errors.Is(err, ErrWebAuthnCredentialChanged) {
					errs <- err
				}
			}()
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			t.Fatal(err)
		}
		if updates.Load() != 1 {
			t.Fatalf("concurrent WebAuthn credential updates = %d, want 1", updates.Load())
		}

		counterless := WebAuthnCredential{
			ID:   base64.RawURLEncoding.EncodeToString([]byte(prefix + "-counterless")),
			Name: "Synced passkey", CredentialData: []byte(`{"id":"counterless"}`),
			Created: now, LastUsed: now.Add(2 * time.Minute),
		}
		if err := st.AddWebAuthnCredential(counterless); err != nil {
			t.Fatal(err)
		}
		if err := st.UpdateWebAuthnCredential(counterless, 0); err != nil {
			t.Fatalf("idempotent counter-less credential update = %v", err)
		}

		flowHash := fmt.Sprintf("%x", sha256.Sum256([]byte(prefix+"-flow")))
		challenge := WebAuthnChallenge{
			FlowHash: flowHash, Kind: "login", SessionData: []byte(`{"challenge":"value"}`),
			Origin: "https://panel.example", RPID: "panel.example", Expires: now.Add(time.Minute),
		}
		if err := st.PutWebAuthnChallenge(challenge); err != nil {
			t.Fatal(err)
		}
		var consumes atomic.Int32
		errs = make(chan error, 2)
		for range 2 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if _, err := st.ConsumeWebAuthnChallenge(challenge.FlowHash, challenge.Kind, now); err == nil {
					consumes.Add(1)
				} else if !errors.Is(err, ErrWebAuthnChallenge) {
					errs <- err
				}
			}()
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			t.Fatal(err)
		}
		if consumes.Load() != 1 {
			t.Fatalf("concurrent WebAuthn challenge consumes = %d, want 1", consumes.Load())
		}
		expiredHash := fmt.Sprintf("%x", sha256.Sum256([]byte(prefix+"-expired")))
		if err := st.PutWebAuthnChallenge(WebAuthnChallenge{FlowHash: expiredHash, Kind: "login", SessionData: []byte("{}"), Origin: "https://panel.example", RPID: "panel.example", Expires: now.Add(-time.Second)}); err != nil {
			t.Fatal(err)
		}
		if _, err := st.ConsumeWebAuthnChallenge(expiredHash, "login", now); !errors.Is(err, ErrWebAuthnChallenge) {
			t.Fatalf("expired challenge error = %v", err)
		}
		var firstCapacityChallenge WebAuthnChallenge
		for i := range webAuthnChallengeLimit {
			flowHash := fmt.Sprintf("%x", sha256.Sum256([]byte(prefix+"-capacity-"+strconv.Itoa(i))))
			item := WebAuthnChallenge{
				FlowHash: flowHash, Kind: "login", SessionData: []byte(`{}`),
				Origin: "https://panel.example", RPID: "panel.example", Expires: now.Add(time.Hour),
			}
			if i == 0 {
				firstCapacityChallenge = item
			}
			if err := st.PutWebAuthnChallenge(item); err != nil {
				t.Fatalf("fill WebAuthn challenge capacity at %d: %v", i, err)
			}
		}
		overflowHash := fmt.Sprintf("%x", sha256.Sum256([]byte(prefix+"-capacity-overflow")))
		if err := st.PutWebAuthnChallenge(WebAuthnChallenge{
			FlowHash: overflowHash, Kind: "login", SessionData: []byte(`{}`),
			Origin: "https://panel.example", RPID: "panel.example", Expires: now.Add(time.Hour),
		}); !errors.Is(err, ErrWebAuthnChallengeLimit) {
			t.Fatalf("challenge capacity error = %v", err)
		}
		if err := st.PutWebAuthnChallenge(firstCapacityChallenge); err != nil {
			t.Fatalf("replace challenge at capacity: %v", err)
		}
		if err := st.DeleteWebAuthnCredential(credential.ID); err != nil {
			t.Fatal(err)
		}
		if err := st.DeleteWebAuthnCredential(counterless.ID); err != nil {
			t.Fatal(err)
		}
		if err := st.DeleteWebAuthnCredential(credential.ID); !errors.Is(err, ErrWebAuthnCredentialNotFound) {
			t.Fatalf("missing credential delete error = %v", err)
		}
	})

	t.Run("settings_and_nonce", func(t *testing.T) {
		if err := st.SetSetting(prefix, "one"); err != nil {
			t.Fatal(err)
		}
		if err := st.SetSetting(prefix, "two"); err != nil {
			t.Fatal(err)
		}
		if got, ok, err := st.GetSetting(prefix); err != nil || !ok || got != "two" {
			t.Fatalf("GetSetting = %q, %v, %v", got, ok, err)
		}
		if err := st.SetSubpageNonce(prefix, "nonce-1"); err != nil {
			t.Fatal(err)
		}
		if err := st.SetSubpageNonce(prefix, "nonce-2"); err != nil {
			t.Fatal(err)
		}
		if got, err := st.GetSubpageNonce(prefix); err != nil || got != "nonce-2" {
			t.Fatalf("GetSubpageNonce = %q, %v", got, err)
		}
	})

	t.Run("audit_and_journal", func(t *testing.T) {
		auditID := prefix + "-audit"
		if err := st.AppendAudit(AuditEntry{TS: now, ID: auditID, Action: "contract", Outcome: "success"}); err != nil {
			t.Fatal(err)
		}
		audit, err := st.ListAudit(1000)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, entry := range audit {
			found = found || entry.ID == auditID
		}
		if !found {
			t.Fatalf("audit entry %q not found", auditID)
		}

		target := prefix + "-panel"
		if err := st.AppendUpdateJournal(UpdateJournalEntry{Target: target, RunID: prefix, Phase: "checking", TS: now}); err != nil {
			t.Fatal(err)
		}
		journal, err := st.ListUpdateJournal(target, 10)
		if err != nil || len(journal) != 1 || journal[0].RunID != prefix {
			t.Fatalf("ListUpdateJournal = %+v, %v", journal, err)
		}
	})

	t.Run("history_events", func(t *testing.T) {
		entity := "dc:" + prefix
		event := HistoryEvent{
			TS: now, Category: StorageEvents, Kind: "dc.coverage.changed",
			Entity: entity, State: "66", PreviousState: "100", Severity: "warning",
			Attributes: map[string]string{"route": "media"},
		}
		if err := st.AppendHistoryEvent(event); err != nil {
			t.Fatal(err)
		}
		got, err := st.ListHistoryEvents(HistoryEventFilter{From: now.Add(-time.Second), Category: StorageEvents, Kind: event.Kind, Entity: entity, Limit: 1})
		if err != nil || len(got) != 1 {
			t.Fatalf("ListHistoryEvents = %+v, %v", got, err)
		}
		if got[0].ID <= 0 || got[0].State != "66" || got[0].PreviousState != "100" || got[0].Attributes["route"] != "media" {
			t.Fatalf("history event = %+v", got[0])
		}
	})

	t.Run("metrics_policies_and_stats", func(t *testing.T) {
		metric := "traffic"
		point := MetricPoint{TS: now.Unix(), Value: 42.5}
		if err := st.RecordMetric(metric, point); err != nil {
			t.Fatal(err)
		}
		points, err := st.MetricRange(metric, now.Add(-time.Minute).Unix())
		if err != nil || len(points) == 0 || points[len(points)-1] != point {
			t.Fatalf("MetricRange = %+v, %v", points, err)
		}
		if err := st.RecordMetrics([]NamedMetricPoint{
			{Name: "connections", Point: MetricPoint{TS: now.Unix(), Value: 3}},
			{Name: "active_users", Point: MetricPoint{TS: now.Unix(), Value: 2}},
		}); err != nil {
			t.Fatal(err)
		}
		if got, err := st.MetricRange("active_users", now.Add(-time.Minute).Unix()); err != nil || len(got) != 1 || got[0].Value != 2 {
			t.Fatalf("batched MetricRange = %+v, %v", got, err)
		}
		policies, err := st.ListStoragePolicies()
		if err != nil || len(policies) != len(DefaultStoragePolicies()) {
			t.Fatalf("ListStoragePolicies = %+v, %v", policies, err)
		}
		if err := st.ReplaceStoragePolicies(policies); err != nil {
			t.Fatal(err)
		}
		stats, err := st.StorageStats()
		if err != nil || stats.Driver != st.Driver() || len(stats.Categories) != len(policies) {
			t.Fatalf("StorageStats = %+v, %v", stats, err)
		}
		if err := st.PurgeHistory(StorageTraffic); err != nil {
			t.Fatal(err)
		}
		if points, err := st.MetricRange(metric, 0); err != nil || len(points) != 0 {
			t.Fatalf("MetricRange after purge = %+v, %v", points, err)
		}
		for i := range policies {
			if policies[i].Category == StorageTraffic {
				policies[i].Enabled = false
			}
		}
		if err := st.ReplaceStoragePolicies(policies); err != nil {
			t.Fatal(err)
		}
		if err := st.RecordMetric(metric, MetricPoint{TS: now.Add(time.Second).Unix(), Value: 50}); err != nil {
			t.Fatal(err)
		}
		if points, err := st.MetricRange(metric, 0); err != nil || len(points) != 0 {
			t.Fatalf("disabled traffic persisted = %+v, %v", points, err)
		}
		for i := range policies {
			if policies[i].Category == StorageTraffic {
				policies[i].Enabled = true
			}
		}
		if err := st.ReplaceStoragePolicies(policies); err != nil {
			t.Fatal(err)
		}
		visible := MetricPoint{TS: now.Add(2 * time.Second).Unix(), Value: 60}
		if err := st.RecordMetric(metric, visible); err != nil {
			t.Fatal(err)
		}
		if points, err := st.MetricRange(metric, 0); err != nil || len(points) == 0 || points[len(points)-1] != visible {
			t.Fatalf("re-enabled traffic did not persist = %+v, %v", points, err)
		}
	})

	t.Run("sparse_user_traffic", func(t *testing.T) {
		username := prefix + "-traffic"
		policies, err := st.ListStoragePolicies()
		if err != nil {
			t.Fatal(err)
		}
		for i := range policies {
			if policies[i].Category == StorageUserTraffic {
				policies[i].Enabled = true
			}
		}
		if err := st.ReplaceStoragePolicies(policies); err != nil {
			t.Fatal(err)
		}
		sourceStartedAt := now.Add(-time.Hour).Unix()
		if _, err := st.ApplyUserTrafficSnapshot(UserTrafficSnapshot{
			ObservedAt: now.Unix(), SourceStartedAt: sourceStartedAt, TelemetryEnabled: true,
			Users: []UserTrafficObservation{{Username: username, RawOctets: 100}},
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := st.ApplyUserTrafficSnapshot(UserTrafficSnapshot{
			ObservedAt: now.Add(time.Minute).Unix(), SourceStartedAt: sourceStartedAt, TelemetryEnabled: true,
			Users: []UserTrafficObservation{{Username: username, RawOctets: 250}},
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := st.ApplyUserTrafficSnapshot(UserTrafficSnapshot{
			ObservedAt: now.Add(2 * time.Minute).Unix(), SourceStartedAt: sourceStartedAt, TelemetryEnabled: true,
			Users: []UserTrafficObservation{{Username: username, RawOctets: 250}},
		}); err != nil {
			t.Fatal(err)
		}
		points, err := st.UserTrafficRange(username, now.Add(-time.Hour).Unix())
		if err != nil || len(points) != 1 || points[0].Tier != MetricTierQuarter || points[0].Bytes != 150 {
			t.Fatalf("UserTrafficRange = %+v, %v", points, err)
		}
		if st.UserTrafficRetention() <= 0 {
			t.Fatal("enabled user traffic retention is zero")
		}
		if err := st.DeleteUserHistory(username); err != nil {
			t.Fatal(err)
		}
		if points, err := st.UserTrafficRange(username, now.Add(-time.Hour).Unix()); err != nil || len(points) != 0 {
			t.Fatalf("history survived user deletion: %+v, %v", points, err)
		}
	})

	t.Run("user_traffic_snapshot_is_atomic", func(t *testing.T) {
		alice := prefix + "-atomic-alice"
		bob := prefix + "-atomic-bob"
		base := now.Add(5 * time.Minute).Unix()
		first := UserTrafficSnapshot{
			ObservedAt: base, SourceStartedAt: base - 3600, TelemetryEnabled: true,
			Users: []UserTrafficObservation{{Username: alice, RawOctets: 0}, {Username: bob, RawOctets: math.MaxInt64}},
		}
		if _, err := st.ApplyUserTrafficSnapshot(first); err != nil {
			t.Fatal(err)
		}
		failed := UserTrafficSnapshot{
			ObservedAt: base + 60, SourceStartedAt: base - 1800, TelemetryEnabled: true,
			Users: []UserTrafficObservation{{Username: alice, RawOctets: 100}, {Username: bob, RawOctets: math.MaxInt64}},
		}
		if _, err := st.ApplyUserTrafficSnapshot(failed); err == nil {
			t.Fatal("overflowing snapshot succeeded")
		}
		state, err := st.UserTrafficCollectorState()
		if err != nil || state.LastSuccessTS != base {
			t.Fatalf("collector advanced after failed snapshot: %+v, %v", state, err)
		}
		retry := UserTrafficSnapshot{
			ObservedAt: base + 120, SourceStartedAt: base - 3600, TelemetryEnabled: true,
			Users: []UserTrafficObservation{{Username: alice, RawOctets: 200}, {Username: bob, RawOctets: math.MaxInt64}},
		}
		result, err := st.ApplyUserTrafficSnapshot(retry)
		if err != nil || result.DeltaBytes != 200 {
			t.Fatalf("retry = %+v, %v, want delta 200", result, err)
		}
		summaries, err := st.UserTrafficSummaries()
		if err != nil || summaries[alice].ObservedTotalBytes != 200 || summaries[bob].ObservedTotalBytes != 0 {
			t.Fatalf("summaries after retry = %+v, %v", summaries, err)
		}
	})

	t.Run("paused_source_does_not_create_a_baseline", func(t *testing.T) {
		username := prefix + "-paused-baseline"
		base := now.Add(10 * time.Minute).Unix()
		source := base - 3600
		if _, err := st.ApplyUserTrafficSnapshot(UserTrafficSnapshot{
			ObservedAt: base, SourceStartedAt: source, TelemetryEnabled: false,
			Users: []UserTrafficObservation{{Username: username, RawOctets: 0}},
		}); err != nil {
			t.Fatal(err)
		}
		if summaries, err := st.UserTrafficSummaries(); err != nil {
			t.Fatal(err)
		} else if _, exists := summaries[username]; exists {
			t.Fatalf("paused first snapshot created a user baseline: %+v", summaries[username])
		}
		result, err := st.ApplyUserTrafficSnapshot(UserTrafficSnapshot{
			ObservedAt: base + 60, SourceStartedAt: source, TelemetryEnabled: true,
			Users: []UserTrafficObservation{{Username: username, RawOctets: 500}},
		})
		if err != nil || result.DeltaBytes != 0 {
			t.Fatalf("first enabled snapshot = %+v, %v", result, err)
		}
	})

	t.Run("user_traffic_lifecycle", func(t *testing.T) {
		username := prefix + "-lifecycle"
		base := now.Add(15 * time.Minute).Unix()
		source := base - 3600
		apply := func(at int64, enabled bool, users ...UserTrafficObservation) UserTrafficApplyResult {
			t.Helper()
			result, err := st.ApplyUserTrafficSnapshot(UserTrafficSnapshot{
				ObservedAt: at, SourceStartedAt: source, TelemetryEnabled: enabled, Users: users,
			})
			if err != nil {
				t.Fatal(err)
			}
			return result
		}
		apply(base, true, UserTrafficObservation{Username: username, RawOctets: 100})
		if got := apply(base+60, true, UserTrafficObservation{Username: username, RawOctets: 150}).DeltaBytes; got != 50 {
			t.Fatalf("normal delta = %d, want 50", got)
		}
		apply(base+120, false, UserTrafficObservation{Username: username, RawOctets: 150})
		if got := apply(base+180, true, UserTrafficObservation{Username: username, RawOctets: 170}).DeltaBytes; got != 20 {
			t.Fatalf("resumed delta = %d, want 20", got)
		}
		if got := apply(base+240, true, UserTrafficObservation{Username: username, RawOctets: 5}).DeltaBytes; got != 5 {
			t.Fatalf("counter reset delta = %d, want 5", got)
		}
		source = base + 250
		if got := apply(base+270, true, UserTrafficObservation{Username: username, RawOctets: 7}).DeltaBytes; got != 7 {
			t.Fatalf("process restart delta = %d, want 7", got)
		}
		apply(base+300, true)
		summaries, err := st.UserTrafficSummaries()
		if err != nil || summaries[username].DeletedEpochSecs != base+300 {
			t.Fatalf("deleted summary = %+v, %v", summaries[username], err)
		}
		if got := apply(base+360, true, UserTrafficObservation{Username: username, RawOctets: 8}).DeltaBytes; got != 1 {
			t.Fatalf("reappeared delta = %d, want 1", got)
		}
		if got := apply(base+360+int64(25*time.Hour/time.Second), true, UserTrafficObservation{Username: username, RawOctets: 18}).DeltaBytes; got != 10 {
			t.Fatalf("post-gap delta = %d, want 10", got)
		}
		summaries, err = st.UserTrafficSummaries()
		if err != nil || summaries[username].ObservedTotalBytes != 93 || summaries[username].DeletedEpochSecs != 0 || summaries[username].Continuity != UserTrafficPartial {
			t.Fatalf("lifecycle summary = %+v, %v", summaries[username], err)
		}
	})

	t.Run("user_traffic_totals_outlive_disabled_buckets", func(t *testing.T) {
		username := prefix + "-totals-only"
		policies, err := st.ListStoragePolicies()
		if err != nil {
			t.Fatal(err)
		}
		for i := range policies {
			if policies[i].Category == StorageUserTraffic {
				policies[i].Enabled = false
			}
		}
		if err := st.ReplaceStoragePolicies(policies); err != nil {
			t.Fatal(err)
		}
		base := now.Add(27 * time.Hour).Unix()
		source := base - 3600
		for _, observation := range []struct {
			at  int64
			raw uint64
		}{{base, 10}, {base + 60, 110}} {
			if _, err := st.ApplyUserTrafficSnapshot(UserTrafficSnapshot{
				ObservedAt: observation.at, SourceStartedAt: source, TelemetryEnabled: true,
				Users: []UserTrafficObservation{{Username: username, RawOctets: observation.raw}},
			}); err != nil {
				t.Fatal(err)
			}
		}
		summaries, err := st.UserTrafficSummaries()
		if err != nil || summaries[username].ObservedTotalBytes != 100 {
			t.Fatalf("totals while disabled = %+v, %v", summaries[username], err)
		}
		if points, err := st.UserTrafficRange(username, 0); err != nil || len(points) != 0 {
			t.Fatalf("disabled bucket history = %+v, %v", points, err)
		}
		for i := range policies {
			if policies[i].Category == StorageUserTraffic {
				policies[i].Enabled = true
			}
		}
		if err := st.ReplaceStoragePolicies(policies); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("reset_all_user_traffic", func(t *testing.T) {
		username := prefix + "-reset-all"
		base := now.Add(28 * time.Hour).Unix()
		source := base - 3600
		for _, raw := range []uint64{10, 110} {
			if _, err := st.ApplyUserTrafficSnapshot(UserTrafficSnapshot{
				ObservedAt: base + int64(raw), SourceStartedAt: source, TelemetryEnabled: true,
				Users: []UserTrafficObservation{{Username: username, RawOctets: raw}},
			}); err != nil {
				t.Fatal(err)
			}
		}
		if err := st.ResetUserTraffic(); err != nil {
			t.Fatal(err)
		}
		if summaries, err := st.UserTrafficSummaries(); err != nil || len(summaries) != 0 {
			t.Fatalf("summaries survived reset: %+v, %v", summaries, err)
		}
		if state, err := st.UserTrafficCollectorState(); err != nil || state.LastSuccessTS != 0 {
			t.Fatalf("collector survived reset: %+v, %v", state, err)
		}
		result, err := st.ApplyUserTrafficSnapshot(UserTrafficSnapshot{
			ObservedAt: base + 300, SourceStartedAt: source, TelemetryEnabled: true,
			Users: []UserTrafficObservation{{Username: username, RawOctets: 210}},
		})
		if err != nil || result.DeltaBytes != 0 {
			t.Fatalf("first snapshot after reset = %+v, %v", result, err)
		}
	})

	t.Run("portable_export", func(t *testing.T) {
		portable, ok := st.(PortableStore)
		if !ok {
			t.Fatalf("%s does not implement PortableStore", st.Driver())
		}
		data, err := portable.ExportData()
		if err != nil {
			t.Fatal(err)
		}
		if data.FormatVersion != portableFormatVersion || data.Settings[prefix] != "two" || data.SubpageNonces[prefix] != "nonce-2" {
			t.Fatalf("portable export omitted state: %+v", data)
		}
		if len(data.Journal[prefix+"-panel"]) != 1 {
			t.Fatalf("portable export journal = %+v", data.Journal[prefix+"-panel"])
		}
		if len(data.Events) != 1 || data.Events[0].Entity != "dc:"+prefix {
			t.Fatalf("portable export events = %+v", data.Events)
		}
	})
	return st
}

func TestMemoryStoreContract(t *testing.T) {
	runStoreContract(t, func(t *testing.T) Store {
		opened, err := NewMemory("")
		if err != nil {
			t.Fatal(err)
		}
		return opened
	})
}
