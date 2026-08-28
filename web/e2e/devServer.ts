// e2e/devServer.ts — the vite dev server the `details` project runs
// against, owned by the one spec that needs it.
//
// Playwright's `webServer` is a CONFIG-level facility: every project in a
// run waits for every entry of it. Declaring vite there made `mobile` and
// `desktop` — which drive the BUILT binary started by globalSetup — boot
// and wait for a dev server they never touch, and silently adopt whatever
// already listened on the port. Scoping it to `details` means owning the
// lifecycle here, from that spec's beforeAll/afterAll.
//
// The reuse rule is deliberate and narrower than `reuseExistingServer`: a
// server this module did not start is used but never killed, so a
// developer running `npm run dev` on the same port keeps it afterwards.
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_PORT, DEV_URL } from "./env";

// e2e -> web (vite's root, where the config and node_modules live).
const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// vite's own entry, run directly by this node: an `npx vite` wrapper would
// take the SIGTERM itself and leave the server it spawned holding the port
// after the suite finished.
const VITE_BIN = path.join(WEB_ROOT, "node_modules", "vite", "bin", "vite.js");
const START_TIMEOUT_MS = 120_000;

let started: ChildProcess | null = null;

async function serving(): Promise<boolean> {
  try {
    const res = await fetch(`${DEV_URL}/dev/details`);
    return res.ok;
  } catch {
    return false;
  }
}

/** Starts vite on DEV_PORT unless something already serves /dev/details. */
export async function startDevServer(): Promise<void> {
  if (started !== null || (await serving())) return;

  const child = spawn(
    process.execPath,
    [VITE_BIN, "--port", String(DEV_PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: WEB_ROOT, stdio: ["ignore", "ignore", "pipe"] },
  );
  // Surfaced rather than swallowed: a strictPort clash or a transform error
  // is otherwise invisible behind a bare readiness timeout.
  child.stderr?.on("data", (d) => process.stderr.write(`[vite] ${d}`));
  started = child;

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await serving()) return;
    if (child.exitCode !== null) {
      started = null;
      throw new Error(`e2e: vite exited with code ${child.exitCode} before serving ${DEV_URL}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  await stopDevServer();
  throw new Error(`e2e: ${DEV_URL}/dev/details did not respond within ${START_TIMEOUT_MS}ms`);
}

/** Stops the server this module started; a reused one is left alone. */
export async function stopDevServer(): Promise<void> {
  const child = started;
  started = null;
  if (child === null || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(forceKill);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
