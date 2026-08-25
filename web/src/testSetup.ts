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
