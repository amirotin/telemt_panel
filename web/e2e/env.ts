// e2e/env.ts — the fixed connection facts every piece of the e2e stack
// needs to agree on ahead of time: playwright.config.ts's `use.baseURL` is
// resolved when the config module is evaluated, which happens BEFORE
// globalSetup runs, so a dynamically-chosen port (the usual "ask the OS
// for a free one" approach) can't be threaded through in time — there is
// no supported hook to feed a late-bound baseURL back into an
// already-parsed config. Fixed, unusual-enough ports sidestep that
// ordering problem entirely; a CI runner and a developer's own machine are
// both are assumed to have nothing else bound to them.
export const PANEL_PORT = 48180;
export const MOCK_PORT = 48190;
export const BASE_URL = `http://127.0.0.1:${PANEL_PORT}`;
export const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;

export const ADMIN_USERNAME = "e2e-admin";
export const ADMIN_PASSWORD = "e2e-test-password-2026";

// A fixed 32-hex-char HMAC key (subpage.secret's documented shape) — the
// value itself has no significance beyond being valid, this stack is
// thrown away after every run.
export const SUBPAGE_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd";

// telemttest's seedDefaultUser() (internal/telemt/telemttest/telemttest.go)
// — the one fixture user that already carries a classic proxy link, so the
// share/sub-page flow has something real to point at. A user created
// through the panel's own CreateUser form always gets empty Links back
// from the mock (matching users.go's handleCreateUser fixture behavior),
// so the "list appears immediately" assertion and the "sub-link renders"
// assertion deliberately exercise two different users rather than forcing
// a mock change just to make one flow cover both — see task-9-report.md.
export const SEEDED_USER = "alice";
