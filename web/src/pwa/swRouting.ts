// swRouting.ts — a verbatim, testable mirror of public/sw.js's
// `classifyRequest`. public/sw.js is a *classic* service worker script
// (src/pwa/registerSW.ts registers it with no `{type: "module"}`, since
// nothing else about it needs ESM), so it can't `import` this file — a
// classic worker can only pull in more classic scripts via
// `importScripts()`, and this project has no bundler step for public/sw.js
// to make that work with a Vite/TypeScript-built module. Keeping one small
// pure function duplicated (rather than adding build tooling just to share
// it) is the tradeoff task-9-report.md's PWA section documents; if this
// function's logic ever changes, public/sw.js's own copy must change with
// it — swRouting.test.ts is what would need retuning together with it, not
// a mechanism that keeps them in sync automatically.
export type RequestClassification = "bypass" | "cache-first" | "network-first";

export function classifyRequest(pathname: string, scopePath: string): RequestClassification {
  if (pathname.startsWith(scopePath + "api/") || pathname.startsWith(scopePath + "sub/")) {
    return "bypass";
  }
  if (pathname.startsWith(scopePath + "assets/")) {
    return "cache-first";
  }
  return "network-first";
}
