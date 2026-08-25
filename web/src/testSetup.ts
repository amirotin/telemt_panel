// Vitest global setup (wired via vite.config.ts's test.setupFiles).
//
// React's `act()` (from the `react` package, used throughout this repo's
// StrictMode-effect tests — e.g. src/realtime/context.test.tsx,
// src/journal/useLogStream.test.tsx) checks `globalThis.IS_REACT_ACT_ENVIRONMENT`
// to decide whether it's running inside a test harness at all. Nothing in
// this project's setup ever set it, so every act()-wrapped render printed
// "The current testing environment is not configured to support act(...)"
// — harmless for the specific renders those tests already assert on (a
// probe test confirmed React's development build still double-invokes
// effects under StrictMode with or without this flag, and a mutation check
// against context.test.tsx's cleanup-dependent assertions confirmed they
// already caught a broken unsubscribe either way — see task-9-report.md),
// but it's the documented, correct way to declare "yes, this is a test
// environment" to React, and leaving it unset is exactly the kind of
// harness gap that can silently change behavior on a future React upgrade.
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Pin the UI language for the whole vitest run. Every component test in
// this repo predates D3 and asserts the Russian strings it was written
// against; jsdom's navigator.language is "en-US", so without this the
// browser-language default (i18n/locale.ts) would flip them all to English.
// Written straight to localStorage — i18n/store.ts resolves the locale
// lazily on its first read, so a value seeded here wins even though the
// store module is imported before any test body runs. A test that wants the
// other language calls setLocalePreference("en") itself.
localStorage.setItem("telemt-panel:locale:v1", "ru");
