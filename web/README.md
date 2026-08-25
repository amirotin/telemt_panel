# Telemt Panel — web

React 19 + TypeScript (strict) + Vite + Tailwind v4 + TanStack Router (file-based) +
TanStack Query. Builds straight into `../internal/webui/dist`, which
`internal/webui` embeds via `go:embed` and serves as the panel's SPA (see that
package's doc comment for the embed/base_path design).

## Running the full stack locally

Three processes, in order:

```bash
# 1. Fake Telemt API on :9091 (internal/telemt/telemttest fixtures — replaces
#    v0's mock-server.mjs)
make mock          # from the repo root (src/)

# 2. The panel itself, against config.toml (copy config.example.toml — the
#    defaults already point [telemt].url at 127.0.0.1:9091)
cp config.example.toml config.toml
# edit auth.password_hash: `go run ./cmd/panel hash-password`
make dev-backend    # go run ./cmd/panel --config config.toml, :8080

# 3. Frontend dev server
cd web
npm install
npm run dev          # :5173, proxies /api and /sub to :8080 (see vite.config.ts)
```

Open http://localhost:5173. The panel backend never needs `internal/webui/dist`
built for this workflow — Vite serves the SPA itself and proxies API/SSE calls
through to `make dev-backend`.

To instead exercise the real embedded build end to end, `make web` (from `src/`)
builds the frontend into `internal/webui/dist`, then `make dev-backend` (or the
built `telemt-panel` binary) serves it directly at `:8080` with no separate
frontend dev server.

## Scripts

| Command | What |
|---|---|
| `npm run dev` | Vite dev server, `/api` + `/sub` proxied to `:8080` (incl. SSE — `changeOrigin`, no buffering) |
| `npm run build` | `tsc --noEmit` then `vite build` → `../internal/webui/dist` |
| `npm run lint` | ESLint (typescript-eslint + react-hooks + react-refresh), one command, no Prettier |
| `npm test` | vitest (jsdom where a test renders DOM) |
| `npm run gen` | Regenerate the API client from `../api/openapi.yaml` — see below |

## Generated API client

`npm run gen` runs `scripts/filter-openapi.mjs` (strips every `x-status: planned`
path from `../api/openapi.yaml` into a gitignored `.openapi-filtered.yaml`) and
then `@hey-api/openapi-ts` (config: `openapi-ts.config.ts`), producing
`src/lib/api/generated/` — typed request functions (`sdk.gen.ts`) and TanStack
Query options factories (`@tanstack/react-query.gen.ts`, e.g. `getHealthOptions()`).

**The generated output is committed**, not regenerated in CI. The contract only
changes when a human edits `openapi.yaml` and deliberately reruns `npm run gen`
— a CI "regenerate and diff" gate would just be a slower, flakier version of
code review catching a stale commit, for a step that has zero runtime
inputs (pure function of the committed spec file). Run `npm run gen` and commit
the result whenever `../api/openapi.yaml` changes.

`src/lib/api/client.ts` wires the generated client's `baseUrl` to
`window.__BASE_PATH__` (injected by `internal/webui` at serve time — see
`src/lib/base-path.ts`) and `credentials: "include"` for the session cookie.

## UI primitives

`src/ui/` is the single source of design-system primitives (Button, Input,
Sheet, StatCard, StatePill, QuotaBar, QR, …) — every screen imports from
`src/ui` (barrel `src/ui/index.ts`), never reimplements. `/dev/ui`
(`src/routes/dev/ui.tsx` → `src/dev/UIShowcase.tsx`) renders every primitive in
every documented state; it's a dev-only route (`import.meta.env.DEV`-gated, see
that file's comment) and stands in for Storybook, which this project doesn't
add.

Design tokens live in `src/styles/tokens.css` (RGB triplets, dark default /
light / system via `[data-theme]`) mapped into Tailwind's `@theme` in
`src/styles/index.css`. Theme persistence: `src/lib/theme.ts` +
`src/lib/useTheme.ts`.

## Formatting

Sources are hand-formatted; Prettier is **not** a dependency and there is no
`format` script. `.prettierrc` exists only to pin the settings an editor (or a
future contributor running `npx prettier`) would otherwise guess — above all
`printWidth: 100`, which is what this tree was written to. Without it Prettier
defaults to 80 and reflows nearly everything: measured against `src/` (generated
code excluded), a run at width 100 touches 137 files, at width 80 it touches 193.

The tree is deliberately *not* Prettier-clean — do not run `--write` across it.
`.prettierignore` covers the two generated trees (`src/lib/api/generated/`,
`src/routeTree.gen.ts`), which must never be reformatted at all.

## Dependencies

Pinned to the plan's approved list (React, Vite, TanStack Router/Query,
Tailwind v4, hey-api, vitest) plus:

- **qrcode** (+ `@types/qrcode`) — local QR generation for the QR primitive, no
  CDN/network, explicitly approved in the task brief.
- **js-yaml** — used by `scripts/filter-openapi.mjs` (dev-time codegen input,
  not shipped) and, since Task 4's fix round 1, `src/i18n/ru.test.ts` (parses
  `../api/openapi.yaml`'s `Error.code` enum directly rather than
  hand-maintaining a second copy of the code list — see that test's own
  comment); no new package needed, just an ambient `src/types/js-yaml.d.ts`
  since neither js-yaml nor `@types/js-yaml` ships types. Pinned via
  `overrides` to 4.3.1 to clear a transitive advisory in
  `@hey-api/openapi-ts`'s own dependency without downgrading it.
- **@eslint/js**, **globals**, **typescript-eslint**, **eslint-plugin-react-hooks**,
  **eslint-plugin-react-refresh** — standard ESLint flat-config wiring, no
  Prettier (see `eslint.config.js`'s comment).
- **@codemirror/state 6.7.1**, **@codemirror/view 6.43.9**,
  **@codemirror/lang-json 6.0.2** — Task 8's Конфигурация raw editor
  (`src/server/config/RawConfigEditor.tsx`), exactly the three packages the
  task brief named as approved. `GET /api/telemt/config`'s `sections` is
  JSON (api/openapi.yaml's `TelemtConfig.sections`), not a TOML file string
  — this is a JSON editor over that object, not a pretend TOML editor —
  hence `@codemirror/lang-json`, no TOML language mode. No
  `@codemirror/commands` (not in the approved list): basic typing/selection
  works through CM6's own DOM input handling without it, but there is no
  Ctrl+Z undo-history stack or Tab-indent keymap — see
  `RawConfigEditor.tsx`'s own doc comment and task-8-report.md's CodeMirror
  decision section. Lazy-loaded (`React.lazy`) and gated behind a
  `min-width: 1024px` check (`src/server/useIsDesktop.ts`) so the ~89KB gz
  chunk never even downloads on a phone — the mobile view is a plain
  read-only `<pre>` (`ReadOnlyJsonView.tsx`), per the brief's own "mobile
  gets read-only, `lg:` gets the editor" split.

No state-management library (zustand, redux, etc.) — `Toast` and, in Task 4,
the SSE topic store use `useSyncExternalStore` directly, per the plan's ruling.
No testing-library — the one DOM-rendering sample test
(`src/ui/StatePill.test.tsx`) uses `react-dom/client` + `act` directly rather
than pull in a dependency for a single test file; revisit if Task 4/5/6's test
suites need more than that.

## Dev-mode proxy and SSE

`vite.config.ts`'s `server.proxy` forwards `/api` and `/sub` to
`http://127.0.0.1:8080` with `changeOrigin: true`. `/api/events*`
(Server-Sent Events, see `02-hub-sse.md`) streams through unbuffered — Vite's
proxy (built on Node's http-proxy, not a buffering reverse proxy) doesn't need
extra configuration for this to work; there is no compression/response
buffering in the dev server's proxy path to disable.

## Go integration

See `internal/webui`'s package doc comment for the embed layout, base_path
injection, and cache-header design.

## Screen → data → topic/endpoint map

Every route, what it renders from, and where that data comes from — the SSE
topics from `02-hub-sse.md` (pushed continuously while the page has a live
subscriber; `useSnapshot<T>("topic")`/`useTopic("topic")`,
`src/realtime/context.tsx`) versus one-shot REST calls (TanStack Query
`xxxOptions()`/`xxxMutation()`, generated from `api/openapi.yaml` into
`src/lib/api/generated/`). Kept here for M4+ to extend without re-deriving it
from scratch.

| Route | Topics (SSE) | REST endpoints |
|---|---|---|
| `/login` | — | `POST /api/auth/login`, `GET /api/auth/me` (guard) |
| `/people`, `/people/$username` | `users` (list, quota, per-user live metrics) | `GET /api/telemt/info` (caps), `POST /api/users`, `PATCH/DELETE /api/users/{username}`, `POST .../reset-quota`, `PUT .../enabled`, `POST .../rotate-secret`, `GET/POST /api/users/{username}/sublink` |
| `/pulse` (widget dashboard) | `stats` (HealthHero, StatRow, ActiveSessions, Problems), `runtime` (MePool, NatStun, Selftest, RecentEvents, Problems, Upstreams), `upstreams` (DC, Upstreams widgets), `security` (SecurityPosture, TlsFingerprints widgets, Problems) | `GET /api/history?metric=&range=` (sparklines) |
| `/pulse/diag/connections` | `stats` | — |
| `/pulse/diag/dc`, `/pulse/diag/upstreams` | `upstreams`, `runtime` | — |
| `/pulse/diag/me`, `/pulse/diag/nat` | `runtime` (+ `upstreams` for ME) | — |
| `/pulse/diag/security` | `security` | — |
| `/pulse/diag/counters` (extended-mode "Счётчики") | — | `GET /api/telemt/zero` (fetched on visit, not a topic — `zero`/`all` are display-only leaf maps, 07-telemt-sdk.md) |
| `/journal` (Логи tab) | — | `GET /api/host` (picks live/tail/gated rung), SSE `GET /api/events/logs?service=` (own `EventSource`, not the topic multiplexer — `src/journal/logStream.ts`), fallback `GET /api/logs/tail?service=&lines=` |
| `/journal` (События tab) | — | `GET /api/audit?limit=&before=` (paginated) |
| `/server` (menu) | — | — |
| `/server/config` | — | `GET/PATCH /api/telemt/config` (If-Match revision), `POST /api/telemt/reload`, `GET /api/telemt/reload/{id}` (polled to terminal), `GET /api/host` (restart cap) |
| `/server/updates` | `update` (live apply steppers, SSE; falls back to polling `GET /api/updates` on SSE loss) | `GET /api/updates`, `POST /api/updates/{target}/apply`, `GET/PUT /api/updates/auto` |
| `/server/security` | `security` | — |
| `/server/platform` | — | `GET /api/host`, `POST /api/telemt/restart` |
| `/server/settings` | — | `GET /api/auth/sessions`, `DELETE /api/auth/sessions` (revoke others), `DELETE /api/auth/sessions/{sessionId}`, `POST /api/telemt/restart`; theme/display-mode/dashboard-layout are localStorage only, no endpoint |
| Shell (every authed route) | `stats` (StatusStrip health/connections/traffic) | `GET /api/auth/me` (session guard, `_authed.tsx`) |

Notes:
- `stats`/`runtime`/`upstreams`/`security`/`update` all flow through the one
  app-wide `EventSource` multiplexer (`src/realtime/sseClient.ts`) — a page
  subscribing to a topic just adds it to that connection's active set, it
  never opens its own connection. The Journal Логи tab's log stream is the
  one deliberate exception (its own `EventSource`, `src/journal/logStream.ts`)
  since it's a distinct, high-volume, per-service stream outside the topic
  protocol.
- A user mutation (create/edit/delete/enable/rotate-secret/reset-quota,
  sublink regenerate) triggers a server-side `Hub.Poke("users")` after a
  short delay (`internal/hub`) so the `users` topic's next SSE frame reflects
  it almost immediately, without waiting for that topic's normal poll
  interval — this is what `web/e2e/mobile.spec.ts`'s "user appears in the
  list without a manual reload" step exercises end to end.

## e2e (Playwright)

`web/e2e/` (chromium only, plan Ruling R4) runs against the **real built
panel binary** + `cmd/telemt-mock` — never the vite dev server, never a
mocked `fetch`. Two projects: `mobile` (360×640 — the primary target, one
sequential flow through login → create a user → share/sub-page → Пульс
dashboard + layout editor → Журнал → Сервер) and `desktop` (1280×800 smoke —
sidebar, the Raw config editor/CodeMirror actually mounting at `lg:`).

```bash
npx playwright install chromium   # once per machine
make build                        # from the repo root (src/) — the panel binary e2e runs against
cd web
npm run e2e                       # playwright test
```

- `e2e/stack.ts` builds `cmd/telemt-mock` itself (a dev/test-only binary,
  never part of `make build`/`make release`) into a scratch temp dir, hashes
  a fixed admin password through the real `telemt-panel hash-password`
  subcommand, writes a scratch `config.toml` (memory store, `data_dir = ""`,
  subpage enabled with a throwaway secret), and launches both processes —
  see `e2e/global-setup.ts` (Playwright's "return a teardown function from
  globalSetup" pattern) and `e2e/env.ts` for the fixed ports/credentials
  every piece of the stack agrees on ahead of time. It does **not** build
  the panel binary itself — that's `make build`'s job, run once before
  `npm run e2e`, exactly like a developer already has to for any other
  end-to-end check against the real embedded SPA.
- The share/sub-page flow deliberately exercises `alice` (the fixture user
  `telemttest.New` seeds with a real classic proxy link), not the user the
  test just created — `cmd/telemt-mock`'s `CreateUser` fixture always
  returns empty `Links` (matching `internal/telemt/telemttest/users.go`), so
  a freshly created user never has a sub-link to share. See `e2e/env.ts`'s
  `SEEDED_USER` comment.
- CI runs this as its own `e2e` job (`.github/workflows/ci.yml`, after the
  `build` job), with `retries: 1` (via `CI=true`) and the Playwright HTML
  report + `test-results/` (screenshots, traces) uploaded as artifacts on
  failure.

## PWA

`public/manifest.webmanifest` + `public/icon.svg` (name/icons/theme_color)
and `public/sw.js` (app-shell caching: network-first for `index.html`,
cache-first for the content-hashed `assets/` bundle, `/api/*` and `/sub/*`
never touched — 06-ui.md: "offline — последние снапшоты топиков из памяти
вкладки", not a service-worker cache) are both static files Vite copies
as-is; registration is `src/pwa/registerSW.ts`, called from `main.tsx`,
production builds only. `public/apple-touch-icon.png` +
`public/icon-{192,512}.png` (generated by `node scripts/generate-icons.mjs`
— screenshots `icon.svg` through the Chromium build `@playwright/test`
already bundles, since no raster/SVG-to-PNG library is on the approved
dependency list; re-run manually whenever `icon.svg` changes) fill the gap
Safari's "add to home screen" leaves for an SVG-only manifest (it ignores
`rel="icon"`/SVG manifest entries and needs a real `apple-touch-icon` PNG).
`icon-192.png`/`icon-512.png` are declared `"purpose": "any maskable"` — the
SVG's ring/dot content already sits inside the maskable safe zone (its
farthest extent is a 22px radius inside a 32px half-size square, well under
the 80%-diameter safe circle), so one raster per size covers both purposes
without a separately-cropped maskable variant.

`public/sw.js`'s whole routing policy (bypass `/api`+`/sub`, cache-first for
`assets/`, network-first for everything else — i.e. the shell) is one pure
function, `classifyRequest`. It's mirrored (not shared — a classic service
worker script can't `import` a Vite/TypeScript module, only
`importScripts()` another classic script) as `src/pwa/swRouting.ts`, unit
tested in `src/pwa/swRouting.test.ts`; see that file's own comment for the
duplication tradeoff.

**Hand-written SW, not vite-plugin-pwa**: the whole caching policy is three
rules, which is simpler to read, audit, and keep in sync with
`internal/webui`'s own cache-header story (immutable `assets/`, no-cache
elsewhere — `internal/webui/webui.go`) as ~90 lines of plain JS than to
configure correctly through a plugin's Workbox strategy DSL, register its Vite
plugin, and reason about what it generates. Revisit if a future task needs
richer offline behavior (background sync, precache manifests with revisioning)
that would make a hand-rolled SW harder to maintain than adopting the plugin.

`internal/webui` registers `.webmanifest` → `application/manifest+json` (Go's
builtin mime map has no association for it, so `http.FileServer` used to sniff
it as `text/plain` — see that package's `init()`); `sw.js` gets Go's normal
`.js` mime type and the same no-cache header as `manifest.webmanifest` (both
are outside the `assets/` immutable-cache namespace, so a redeploy is always
picked up — required for a service worker file specifically, not just
incidental). `CACHE_NAME` in `public/sw.js` must be bumped on any change to
that file's caching policy or precached `SHELL_URLS` — `activate` deletes
every cache that doesn't match the current name, which is what makes a
`sw.js` update actually replace a previously-cached shell instead of serving
it forever.

## Bundle size

`npm run build`'s own gzip report is the source of truth (re-run it to check
current numbers). As of Task 9: the entry chunk (`assets/index-*.js`, React +
router + query + every eagerly-used primitive) is **~294 kB / ~94 kB gz** —
comfortably under the plan's "первый экран < 300КБ gz" orientation figure
(06-ui.md; not a CI gate). The one large lazy chunk, CodeMirror
(`assets/RawConfigEditor-*.js`, ~274 kB / ~89 kB gz), is correctly split off
the entry chunk — it only downloads when a `lg:` viewport visits
Сервер → Конфигурация → Raw (`React.lazy` + `useIsDesktop`, see the
CodeMirror dependency note above), never on first load.
