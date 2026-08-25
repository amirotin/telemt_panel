// Minimal hand-written service worker — app-shell caching only. No API
// caching (/api/*, /sub/* are always live data, never cached — Task 4
// deliverable G: "SW-кеш оболочки, без offline-данных сверх памяти
// вкладки"). Hand-written rather than vite-plugin-pwa: the whole policy is
// three rules (network-first for index.html, cache-first for the
// content-hashed assets/ bundle, never touch /api or /sub), simpler to
// read and audit as plain JS than to configure correctly through a
// plugin's Workbox strategy DSL for a shell this small — see
// web/README.md for the tradeoff written out. Registered by
// src/pwa/registerSW.ts, production builds only.
//
// CACHE_NAME is the version to bump on any change to this file's caching
// policy or SHELL_URLS — the `activate` handler below deletes every cache
// that doesn't match the current name, so a bump is what makes a deployed
// update actually replace a previously-cached shell rather than serving it
// forever. v2 (Task 9): added the PNG icons generated for the manifest/
// apple-touch-icon.
const CACHE_NAME = "telemt-panel-shell-v2";
const SCOPE_PATH = new URL(self.registration.scope).pathname;
const SHELL_URLS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

// classifyRequest is the SW's whole routing policy as one pure function —
// no `self`/`caches`/`fetch` reference, so it's a plain function this
// file's own `fetch` handler below calls directly, AND (duplicated
// verbatim, see that file's own comment on why) what
// src/pwa/swRouting.ts's vitest coverage exercises. A classic service
// worker script (this file — registerSW.ts registers it with no `{type:
// "module"}`) can't use an ES `import` to share one real copy with
// src/pwa/ (only `importScripts()`, which can't pull from a
// Vite/TypeScript-built module without adding a bundler step to
// public/sw.js itself) — see task-9-report.md's PWA section for why a
// small kept-in-sync duplicate was chosen over that.
function classifyRequest(pathname, scopePath) {
  if (pathname.startsWith(scopePath + "api/") || pathname.startsWith(scopePath + "sub/")) {
    return "bypass";
  }
  if (pathname.startsWith(scopePath + "assets/")) {
    return "cache-first";
  }
  return "network-first";
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const decision = classifyRequest(url.pathname, SCOPE_PATH);
  if (decision === "bypass") return;
  event.respondWith(decision === "cache-first" ? cacheFirst(request) : networkFirst(request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw err;
  }
}
