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
// Cache Storage is shared by all applications on an origin. Encode the scope
// and delimit it so a nested panel can never match another panel's versions.
const SCOPE_PATH = new URL(self.registration.scope).pathname;
const CACHE_PREFIX = "telemt-panel-shell:" + encodeURIComponent(SCOPE_PATH) + ":";
const CACHE_NAME = CACHE_PREFIX + "v4";
const SHELL_URLS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

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
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE_PATH)) return;

  const decision = classifyRequest(url.pathname, SCOPE_PATH);
  if (decision === "bypass") return;
  event.respondWith(decision === "cache-first" ? cacheFirst(event) : networkFirst(event));
});

async function cachedResponse(request) {
  const cache = await caches.open(CACHE_NAME);
  return cache.match(request);
}

function remember(event, response) {
  if (response.ok) {
    const copy = response.clone();
    const write = caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
    event.waitUntil(write.catch(() => {}));
  }
  return response;
}

async function cacheFirst(event) {
  const cached = await cachedResponse(event.request).catch(() => undefined);
  if (cached) return cached;
  return remember(event, await fetch(event.request));
}

async function networkFirst(event) {
  try {
    return remember(event, await fetch(event.request));
  } catch (error) {
    const cached = await cachedResponse(event.request).catch(() => undefined);
    if (cached) return cached;
    throw error;
  }
}
