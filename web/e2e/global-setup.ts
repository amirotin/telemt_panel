// e2e/global-setup.ts — Playwright's documented "start a server, return a
// teardown function" pattern: globalSetup runs once, in the same process
// that orchestrates every worker, so process handles created here survive
// for the whole run and the returned function is what Playwright calls
// once every test file has finished (success or failure) — see
// playwright.config.ts's `globalSetup` field.
import { startStack, stopStack } from "./stack";

export default async function globalSetup(): Promise<() => Promise<void>> {
  // The stack start is not covered by Playwright's per-test retries: a
  // transient bind/health hiccup here would fail the whole run, so retry
  // once before giving up.
  let stack;
  try {
    stack = await startStack();
  } catch (err) {
    console.warn("e2e stack start failed once, retrying:", err);
    await new Promise((r) => setTimeout(r, 1500));
    stack = await startStack();
  }
  return async () => {
    await stopStack(stack);
  };
}
