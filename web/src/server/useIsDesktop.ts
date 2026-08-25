import { useSyncExternalStore } from "react";

const QUERY = "(min-width: 1024px)"; // Tailwind's `lg:` breakpoint (default, unmodified in tokens.css/styles)

function subscribe(callback: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function getSnapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

// useIsDesktop mirrors the `lg:` breakpoint in JS — needed only where a
// component decision (not just styling) depends on it: the Конфигурация
// raw editor must not even import the CodeMirror chunk on a phone (06-ui.md:
// "raw-редактор — только lg:, на мобайле — read-only просмотр"), which a
// CSS-only `hidden lg:block` can't express since both branches would still
// load the module.
export function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
