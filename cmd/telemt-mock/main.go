// Command telemt-mock is a dev-only fake Telemt control API, wrapping
// internal/telemt/telemttest, for developing and testing the panel (and
// its web frontend once it exists) without a real Telemt instance running.
// It replaces the 0.x panel's .claude/mock-server.mjs. Not part of any
// release artifact — see Makefile's release target, which never builds
// this command, and TestReleaseContract (internal/update), which proves
// the release tarballs it produces contain only cmd/panel's binary.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/amirotin/telemt_panel/internal/telemt/telemttest"
)

// scenarios maps the -scenario flag's accepted values to the
// telemttest.Scenario knobs they set — one flag standing in for the
// hand-picked combinations a panel/frontend developer actually needs to
// exercise (07-telemt-sdk.md §SDK-8's "old build without quota/reload",
// "runtime_edge off", "read_only"), rather than exposing every Scenario
// field as its own flag.
var scenarios = map[string]telemttest.Scenario{
	// full: every capability on, including runtime_edge — the "everything
	// works" case a frontend widget catalog needs to render completely.
	"full": {RuntimeEdge: true},
	// old-build: quota/reload/config-API routes 404 bare, as on a Telemt
	// build that predates them.
	"old-build": {OldBuild: true},
	// edge-off: the stock-config default — runtime_edge_enabled is false,
	// same as Scenario{}'s zero value, spelled out explicitly here so the
	// flag's value is self-documenting rather than relying on a reader
	// already knowing Scenario's zero value is the "off" case.
	//
	// End to end this is the OMITTED-field wire shape: the panel's
	// capability probe reads `enabled:false` off /v1/runtime/connections/
	// summary, so hub.go never fetches the runtime-edge payloads and drops
	// `connections_summary`/`recent_events` from the topic JSON entirely
	// (their `omitempty` tags). The Details builder must read that absence
	// as the gate being off — details-builder/sources.ts.
	"edge-off": {},
	// edge-gated: the other wire shape — an EXPLICIT `{enabled:false,
	// reason}` wrapper instead of a missing key. runtime_edge is on (so
	// Соединения/События/TLS have real data and the capability probe
	// passes), while minimal_runtime_enabled is off, which is how Telemt
	// gates the four /v1/stats/* routes: upstreams, minimal/all, me-writers
	// and dcs. They are fetched unconditionally and arrive as a
	// present-but-disabled wrapper with reason `feature_disabled`, so ДЦ/ME
	// take the wrapper branch here and the missing-key branch under
	// `edge-off`; both must land on the same GatedNote.
	//
	// NAT/STUN and the rest of /v1/runtime/* stay LIVE here: no config flag
	// gates them (src/api/runtime_min.rs takes no ApiConfig) — see
	// `me-pool-down` for the scenario that actually closes them.
	"edge-gated": {RuntimeEdge: true, MinimalRuntimeOff: true},
	// me-pool-down: `use_middle_proxy = false`, or a pool that has not
	// finished initializing. Everything backed by the ME pool closes with
	// reason `source_unavailable` — nat_stun, me_pool_state, me_quality,
	// me_selftest and the `minimal` payload's nested me_writers/dcs — while
	// runtime_edge stays on. This is the ONLY scenario that gates NAT/STUN,
	// and the one that must NOT produce a "flip a config flag" hint.
	"me-pool-down": {RuntimeEdge: true, MePoolDown: true},
	// upstream-source-down: the upstream manager's snapshot try_read lost
	// the race, so /v1/stats/upstreams and /v1/runtime/upstream-quality
	// report `source_unavailable` with policy and counters still filled.
	"upstream-source-down": {RuntimeEdge: true, UpstreamSourceDown: true},
	// read-only: every mutation 403s with read_only, matching Telemt's
	// read_only config gate.
	"read-only": {ReadOnly: true},
	// web-off: a Telemt 3.5.3+ build whose WEB runtime is not running —
	// no `transport = "web"` listener, or `web.enabled = false`. The WEB
	// status route still answers (available:false, reason
	// `no_web_listener`) while the sessions/close/operations routes answer
	// 503 web_runtime_unavailable. The panel must render this as a gate
	// with a "включите [web]" hint, never as an error.
	"web-off": {RuntimeEdge: true, WebOff: true},
}

func main() {
	listen := flag.String("listen", ":9091", "address to listen on")
	scenarioName := flag.String("scenario", "full", "scenario: full|old-build|edge-off|edge-gated|me-pool-down|upstream-source-down|read-only|web-off")
	flag.Parse()

	scenario, ok := scenarios[*scenarioName]
	if !ok {
		fmt.Fprintf(os.Stderr, "telemt-mock: unknown -scenario %q (want full|old-build|edge-off|edge-gated|me-pool-down|upstream-source-down|read-only|web-off)\n", *scenarioName)
		os.Exit(1)
	}

	fake := telemttest.New(scenario)
	// New already started its own httptest.Server on an OS-assigned port —
	// unused here beyond Close, since this command hosts fake.Handler() on
	// its own listener at -listen instead (telemttest.Handler's doc
	// comment).
	defer fake.Close()

	srv := &http.Server{Addr: *listen, Handler: fake.Handler()}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()

	slog.Info("telemt-mock listening", "addr", *listen, "scenario", *scenarioName)
	fmt.Printf("telemt-mock: listening on %s (scenario=%s)\n", displayURL(*listen), *scenarioName)

	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("telemt-mock", "err", err)
			os.Exit(1)
		}
	case <-ctx.Done():
		_ = srv.Shutdown(context.Background())
	}
}

// displayURL renders a -listen value as a clickable http:// URL for the
// startup log line: a bare port (":9091") is the common case (any
// interface) and gets 127.0.0.1 filled in; an address that already names a
// host is used as-is.
func displayURL(addr string) string {
	if len(addr) > 0 && addr[0] == ':' {
		return "http://127.0.0.1" + addr
	}
	return "http://" + addr
}
