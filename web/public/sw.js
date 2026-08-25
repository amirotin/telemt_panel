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
const CACHE_NAME = "telemt-panel-shell-v1";
const SCOPE_PATH = new URL(self.registration.scope).pathname;
const SHELL_URLS = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg"];

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
  // Never cache the API or the (cookie-less, per-token) subscription page —
  // both are always-live data, not app shell.
  if (url.pathname.startsWith(SCOPE_PATH + "api/") || url.pathname.startsWith(SCOPE_PATH + "sub/")) {
    return;
  }

  const isHashedAsset = url.pathname.startsWith(SCOPE_PATH + "assets/");
  event.respondWith(isHashedAsset ? cacheFirst(request) : networkFirst(request));
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
