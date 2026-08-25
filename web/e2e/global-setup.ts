// e2e/global-setup.ts — Playwright's documented "start a server, return a
// teardown function" pattern: globalSetup runs once, in the same process
// that orchestrates every worker, so process handles created here survive
// for the whole run and the returned function is what Playwright calls
// once every test file has finished (success or failure) — see
// playwright.config.ts's `globalSetup` field.
import { startStack, stopStack } from "./stack";

export default async function globalSetup(): Promise<() => Promise<void>> {
  const stack = await startStack();
  return async () => {
    await stopStack(stack);
  };
}
