package telemttest

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

func newWebClient(t *testing.T, scenario Scenario) *telemt.Client {
	t.Helper()
	fake := New(scenario)
	t.Cleanup(fake.Close)
	return telemt.New(fake.URL, "")
}

func TestWebStatusRunningByDefault(t *testing.T) {
	c := newWebClient(t, Scenario{})
	status, err := c.WebStatus(context.Background())
	if err != nil {
		t.Fatalf("WebStatus: %v", err)
	}
	if !status.Available || status.Lifecycle != telemt.WebLifecycleRunning {
		t.Fatalf("status = %+v, want an available running runtime", status)
	}
	if status.Runtime == nil || status.Runtime.Manager == nil {
		t.Fatal("runtime/manager missing on a running fake")
	}
	if len(status.Runtime.Permits) != 8 {
		t.Errorf("permits = %d, want the 8 real semaphores", len(status.Runtime.Permits))
	}
	if !status.Runtime.Manager.IssuanceEnabled {
		t.Error("issuance_enabled = false, want true")
	}
}

func TestWebOffReportsAGateNotAnError(t *testing.T) {
	c := newWebClient(t, Scenario{WebOff: true})
	status, err := c.WebStatus(context.Background())
	if err != nil {
		t.Fatalf("WebStatus must not fail when WEB is off: %v", err)
	}
	if status.Available || status.Reason != "no_web_listener" || status.Runtime != nil {
		t.Errorf("status = %+v, want available=false reason=no_web_listener runtime=nil", status)
	}
	// …while the data routes DO fail, with the documented 503 code.
	if _, err := c.WebSessions(context.Background(), telemt.WebSessionsQuery{}); !telemt.IsWebRuntimeUnavailable(err) {
		t.Errorf("WebSessions err = %v, want web_runtime_unavailable", err)
	}
}

func TestOldBuildHasNoWebRoutesAtAll(t *testing.T) {
	c := newWebClient(t, Scenario{OldBuild: true})
	if _, err := c.WebStatus(context.Background()); !telemt.IsWebRouteAbsent(err) {
		t.Errorf("WebStatus err = %v, want a route-absent 404", err)
	}
	if _, err := c.WebSessions(context.Background(), telemt.WebSessionsQuery{}); !telemt.IsWebRouteAbsent(err) {
		t.Errorf("WebSessions err = %v, want a route-absent 404", err)
	}
}

func TestWebSessionsPageAndCursor(t *testing.T) {
	c := newWebClient(t, Scenario{})
	ctx := context.Background()

	first, err := c.WebSessions(ctx, telemt.WebSessionsQuery{Limit: 20})
	if err != nil {
		t.Fatalf("WebSessions: %v", err)
	}
	if len(first.Sessions) != 20 || first.NextCursor == nil {
		t.Fatalf("first page = %d rows, cursor %v; want a full page and a cursor", len(first.Sessions), first.NextCursor)
	}
	second, err := c.WebSessions(ctx, telemt.WebSessionsQuery{Limit: 20, Cursor: *first.NextCursor})
	if err != nil {
		t.Fatalf("WebSessions page 2: %v", err)
	}
	if len(second.Sessions) != 4 || second.NextCursor != nil {
		t.Fatalf("second page = %d rows, cursor %v; want the tail and no cursor", len(second.Sessions), second.NextCursor)
	}
	// The two pages must not overlap: the cursor is an exclusive bound.
	seen := map[string]bool{}
	for _, row := range append(append([]telemt.WebSessionRow{}, first.Sessions...), second.Sessions...) {
		if seen[row.SessionRef] {
			t.Fatalf("session %s appeared on both pages", row.SessionRef)
		}
		seen[row.SessionRef] = true
	}
}

// The whitelist is the contract the panel's own passthrough mirrors, so the
// fake has to enforce it the way the real route does. The SDK's query
// builder cannot produce an unknown or repeated field, hence the raw
// requests here.
func TestWebSessionsEnforcesTheQueryWhitelist(t *testing.T) {
	fake := New(Scenario{})
	t.Cleanup(fake.Close)

	if _, err := telemt.New(fake.URL, "").WebSessions(context.Background(), telemt.WebSessionsQuery{State: "healthy"}); err != nil {
		t.Fatalf("a whitelisted filter was rejected: %v", err)
	}

	queries := []string{"bogus=1", "user=a&user=b", "limit=0", "limit=201"}
	// Telemt 3.5.5 400s an empty value on every one of the ten names
	// (validate_filter_strings, parse_session_ref, parse_carrier,
	// parse_canonical_ip, "".parse::<usize>() — all verified live), so the
	// fake must too, or the panel's own empty-value rejection would have
	// nothing to be measured against.
	for _, name := range []string{
		"limit", "cursor", "session_ref", "ip", "host",
		"user", "user_agent_id", "key_id", "carrier", "state",
	} {
		queries = append(queries, name+"=")
	}
	ref := webSessionRef(3)
	queries = append(queries,
		"session_ref="+ref+"&limit=5",
		"session_ref="+ref+"&cursor="+webSessionRef(1),
	)
	for _, query := range queries {
		resp, err := http.Get(fake.URL + "/v1/runtime/web/sessions?" + query)
		if err != nil {
			t.Fatalf("GET ?%s: %v", query, err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("GET ?%s = %d, want 400", query, resp.StatusCode)
		}
	}
}

// session_ref is a POINT lookup, not an equality filter: Telemt rewrites it
// into `cursor = id-1, limit = 1`, which is what makes `scanned` come back
// as 1 rather than as the whole prefix of the registry. A fake that matched
// it as a plain filter would let a page look right against the mock and
// report a different scan against a real proxy.
func TestWebSessionsPointLookupMatchesTelemtsRewrite(t *testing.T) {
	c := newWebClient(t, Scenario{})
	ref := webSessionRef(7)

	page, err := c.WebSessions(context.Background(), telemt.WebSessionsQuery{SessionRef: ref})
	if err != nil {
		t.Fatalf("WebSessions: %v", err)
	}
	if len(page.Sessions) != 1 || page.Sessions[0].SessionRef != ref {
		t.Fatalf("point lookup returned %d rows (%v); want exactly %s", len(page.Sessions), page.Sessions, ref)
	}
	if page.Scanned != 1 {
		t.Errorf("scanned = %d, want 1: the window opens just below the id", page.Scanned)
	}
	if page.NextCursor == nil || *page.NextCursor != ref {
		t.Errorf("next_cursor = %v, want %s: the one-row page filled up", page.NextCursor, ref)
	}
}

func TestWebSessionDetailAndTombstone(t *testing.T) {
	c := newWebClient(t, Scenario{})
	ctx := context.Background()

	page, err := c.WebSessions(ctx, telemt.WebSessionsQuery{Limit: 1})
	if err != nil {
		t.Fatalf("WebSessions: %v", err)
	}
	ref := page.Sessions[0].SessionRef

	got, err := c.WebSession(ctx, ref)
	if err != nil {
		t.Fatalf("WebSession: %v", err)
	}
	if got.Row == nil || got.Closed != nil {
		t.Fatalf("got %+v, want a live row", got)
	}

	op, err := c.WebSessionsClose(ctx, telemt.WebCloseRequest{
		RuntimeInstance: got.Row.SessionRef[4 : 4+32],
		Selector:        telemt.WebCloseSelector{Kind: telemt.WebCloseSelectorRefs, SessionRefs: []string{ref}},
	})
	if err != nil {
		t.Fatalf("WebSessionsClose: %v", err)
	}
	if op.State != telemt.WebOperationQueued || op.Requested != 1 {
		t.Fatalf("accepted operation = %+v", op)
	}

	done, err := c.WebOperation(ctx, op.OperationID)
	if err != nil {
		t.Fatalf("WebOperation: %v", err)
	}
	if !telemt.IsWebOperationTerminal(done.State) || done.CloseSignalled != 1 {
		t.Fatalf("operation = %+v, want a terminal close of one session", done)
	}

	// The closed session is gone from the listing and answers a tombstone
	// on the detail route — inside a SUCCESS envelope, HTTP 410.
	after, err := c.WebSession(ctx, ref)
	if err != nil {
		t.Fatalf("WebSession after close: %v", err)
	}
	if after.Row != nil || after.Closed == nil || after.Closed.State != "closed" {
		t.Fatalf("got %+v, want a tombstone", after)
	}
	page, err = c.WebSessions(ctx, telemt.WebSessionsQuery{Limit: 200})
	if err != nil {
		t.Fatalf("WebSessions after close: %v", err)
	}
	for _, row := range page.Sessions {
		if row.SessionRef == ref {
			t.Fatal("a closed session is still listed")
		}
	}
}

func TestWebCloseAllIsRefusedWhileIssuanceIsEnabled(t *testing.T) {
	c := newWebClient(t, Scenario{})
	_, err := c.WebSessionsClose(context.Background(), telemt.WebCloseRequest{
		RuntimeInstance: "0123456789abcdef0123456789abcdef",
		Selector:        telemt.WebCloseSelector{Kind: telemt.WebCloseSelectorAll},
	})
	var apiErr *telemt.APIError
	if !errors.As(err, &apiErr) || apiErr.Code != telemt.CodeWebIssuanceEnabled {
		t.Fatalf("err = %v, want web_issuance_enabled", err)
	}
}

func TestWebCloseFencesOnTheRuntimeInstance(t *testing.T) {
	c := newWebClient(t, Scenario{})
	_, err := c.WebSessionsClose(context.Background(), telemt.WebCloseRequest{
		RuntimeInstance: "ffffffffffffffffffffffffffffffff",
		Selector:        telemt.WebCloseSelector{Kind: telemt.WebCloseSelectorFilter, User: "web-user"},
	})
	var apiErr *telemt.APIError
	if !errors.As(err, &apiErr) || apiErr.Code != telemt.CodeWebRuntimeMismatch {
		t.Fatalf("err = %v, want web_runtime_mismatch", err)
	}
}

func TestWebCloseByFilterClosesTheMatchingSessions(t *testing.T) {
	c := newWebClient(t, Scenario{})
	ctx := context.Background()

	before, err := c.WebSessions(ctx, telemt.WebSessionsQuery{Limit: 200, Carrier: "websocket"})
	if err != nil {
		t.Fatalf("WebSessions: %v", err)
	}
	if len(before.Sessions) == 0 {
		t.Fatal("no websocket sessions seeded — the filter test would pass vacuously")
	}

	op, err := c.WebSessionsClose(ctx, telemt.WebCloseRequest{
		RuntimeInstance: "0123456789abcdef0123456789abcdef",
		Selector:        telemt.WebCloseSelector{Kind: telemt.WebCloseSelectorFilter, Carrier: "websocket"},
	})
	if err != nil {
		t.Fatalf("WebSessionsClose: %v", err)
	}
	// A filter selector has no up-front size: `requested` stays 0 and the
	// counts only arrive with the operation.
	if op.Requested != 0 {
		t.Errorf("requested = %d, want 0 for a filter selector", op.Requested)
	}
	done, err := c.WebOperation(ctx, op.OperationID)
	if err != nil {
		t.Fatalf("WebOperation: %v", err)
	}
	if done.CloseSignalled != len(before.Sessions) {
		t.Errorf("close_signalled = %d, want %d", done.CloseSignalled, len(before.Sessions))
	}
}

func TestWebCloseIsRefusedInReadOnlyMode(t *testing.T) {
	c := newWebClient(t, Scenario{ReadOnly: true})
	_, err := c.WebSessionsClose(context.Background(), telemt.WebCloseRequest{
		RuntimeInstance: "0123456789abcdef0123456789abcdef",
		Selector:        telemt.WebCloseSelector{Kind: telemt.WebCloseSelectorFilter, User: "web-user"},
	})
	var apiErr *telemt.APIError
	if !errors.As(err, &apiErr) || apiErr.Code != "read_only" {
		t.Fatalf("err = %v, want read_only", err)
	}
}

// Lock contention is a state of a RUNNING runtime and has three different
// answers, none of which is "the runtime is off": a status snapshot with the
// plane null and named in partial[], an EMPTY 200 listing that also names it,
// and a 503 web_snapshot_busy on the exact lookup that cannot degrade like
// that. Nothing produced any of them before Scenario.WebBusy existed, so
// web_snapshot_busy and web_operation_in_progress were mapped but untested.
func TestWebBusyReportsContentionNotAbsence(t *testing.T) {
	c := newWebClient(t, Scenario{WebBusy: true})
	ctx := context.Background()

	status, err := c.WebStatus(ctx)
	if err != nil {
		t.Fatalf("WebStatus: %v", err)
	}
	if !status.Available || status.Runtime == nil {
		t.Fatalf("a busy runtime must still be available: %+v", status)
	}
	if status.Runtime.Manager != nil {
		t.Errorf("manager = %+v, want an explicit null", status.Runtime.Manager)
	}
	if len(status.Runtime.Partial) != 1 || status.Runtime.Partial[0] != "manager" {
		t.Errorf("partial = %v, want [manager]", status.Runtime.Partial)
	}

	page, err := c.WebSessions(ctx, telemt.WebSessionsQuery{Limit: 20})
	if err != nil {
		t.Fatalf("WebSessions: %v", err)
	}
	if len(page.Sessions) != 0 {
		t.Errorf("busy listing returned %d rows, want an empty page", len(page.Sessions))
	}
	if len(page.Partial) != 1 || page.Partial[0] != "manager" {
		t.Errorf("page partial = %v, want [manager]: empty must mean busy, not absent", page.Partial)
	}

	if _, err := c.WebSession(ctx, webSessionRef(1)); !isWebAPICode(err, telemt.CodeWebSnapshotBusy) {
		t.Errorf("WebSession error = %v, want %s", err, telemt.CodeWebSnapshotBusy)
	}

	_, err = c.WebSessionsClose(ctx, telemt.WebCloseRequest{
		RuntimeInstance: webRuntimeInstance,
		Selector:        telemt.WebCloseSelector{Kind: telemt.WebCloseSelectorRefs, SessionRefs: []string{webSessionRef(1)}},
	})
	if !isWebAPICode(err, telemt.CodeWebOperationInProgress) {
		t.Errorf("close error = %v, want %s", err, telemt.CodeWebOperationInProgress)
	}
}

func isWebAPICode(err error, code string) bool {
	var apiErr *telemt.APIError
	return errors.As(err, &apiErr) && apiErr.Code == code
}
