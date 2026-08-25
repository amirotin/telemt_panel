import { withBasePath } from "../lib/base-path";

// registerServiceWorker installs the app-shell service worker
// (public/sw.js — see web/README.md for why it's hand-written rather than
// vite-plugin-pwa). Production only: `npm run dev` never registers it, so
// the dev server's own HMR/proxy is never fighting a stale cached shell.
// Guarded for browsers without the API at all.
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register(withBasePath("/sw.js"));
  });
}
