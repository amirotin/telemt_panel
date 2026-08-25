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

## PWA

`public/manifest.webmanifest` + `public/icon.svg` (name/icons/theme_color) and
`public/sw.js` (app-shell caching: network-first for `index.html`, cache-first
for the content-hashed `assets/` bundle, `/api/*` and `/sub/*` never touched —
06-ui.md: "offline — последние снапшоты топиков из памяти вкладки", not a
service-worker cache) are both static files Vite copies as-is; registration
is `src/pwa/registerSW.ts`, called from `main.tsx`, production builds only.

**Hand-written SW, not vite-plugin-pwa**: the whole caching policy is three
rules, which is simpler to read, audit, and keep in sync with
`internal/webui`'s own cache-header story (immutable `assets/`, no-cache
elsewhere — `internal/webui/webui.go`) as ~70 lines of plain JS than to
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
incidental).

## Go integration

See `internal/webui`'s package doc comment for the embed layout, base_path
injection, and cache-header design. Screen → data → topic/endpoint mapping
will be added here as Tasks 5–8 land (per the plan's Task 9).
