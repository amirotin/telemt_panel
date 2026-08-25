// e2e/stack.ts — starts/stops the real panel binary + cmd/telemt-mock for
// the Playwright suite to run against (plan Rulings R4: e2e runs against
// the BUILT binary, not vite dev + a mocked fetch layer). Deliberately
// small and dependency-free: `spawn` + `fetch` polling, no docker-compose,
// no test-container library — see web/README.md's "e2e" section for the
// one-time setup this expects (`make build` for the panel; this module
// builds cmd/telemt-mock itself, since that binary is dev/test-only and
// never part of any `make build`/`make release` output).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN_PASSWORD, ADMIN_USERNAME, BASE_URL, MOCK_PORT, MOCK_URL, PANEL_PORT, SUBPAGE_SECRET } from "./env";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// web/e2e -> web -> src (the Go module root, and where `make build` drops
// ./telemt-panel — see Makefile's `build` target).
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PANEL_BINARY = path.join(REPO_ROOT, "telemt-panel");

export interface Stack {
  panel: ChildProcess;
  mock: ChildProcess;
  tmpDir: string;
}

function run(cmd: string, args: string[], opts: Parameters<typeof spawn>[2] = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

// captureStdout runs a short-lived process and returns its stdout, feeding
// `stdin` in if given — used for `telemt-panel hash-password` (main.go's
// readPassword falls back to reading a full piped stdin line when it isn't
// a TTY, exactly Playwright's non-interactive spawn).
function captureStdout(cmd: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastErr = new Error(`unexpected status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${url} did not become healthy within ${timeoutMs}ms: ${String(lastErr)}`);
}

// startStack: build telemt-mock, hash the admin password, write a scratch
// config.toml (memory store, data_dir="" — nothing touches disk state
// beyond this run's own temp dir), and launch both processes. Throws with
// a clear message if the panel binary is missing — this module builds
// nothing for the panel itself (documented in web/README.md: run
// `make build` from the repo root first).
export async function startStack(): Promise<Stack> {
  if (!existsSync(PANEL_BINARY)) {
    throw new Error(
      `e2e: ${PANEL_BINARY} not found — run "make build" from the repo root (src/) before the e2e suite. ` +
        "The e2e stack deliberately builds nothing for the panel itself; see web/README.md's e2e section.",
    );
  }

  const tmpDir = await mkdtemp(path.join(tmpdir(), "telemt-panel-e2e-"));
  const mockBinary = path.join(tmpDir, "telemt-mock");

  await run("go", ["build", "-o", mockBinary, "./cmd/telemt-mock"], { cwd: REPO_ROOT });

  const passwordHash = await captureStdout(PANEL_BINARY, ["hash-password"], ADMIN_PASSWORD + "\n");

  const configPath = path.join(tmpDir, "config.toml");
  await writeFile(
    configPath,
    [
      `listen = "127.0.0.1:${PANEL_PORT}"`,
      `data_dir = ""`,
      "",
      "[telemt]",
      `url = "${MOCK_URL}"`,
      `auth_header = ""`,
      "",
      "[auth]",
      `username = "${ADMIN_USERNAME}"`,
      `password_hash = "${passwordHash}"`,
      "",
      "[store]",
      `driver = "memory"`,
      "",
      "[subpage]",
      "enabled = true",
      `secret = "${SUBPAGE_SECRET}"`,
      "",
    ].join("\n"),
    "utf8",
  );

  const mock = spawn(mockBinary, ["-listen", `:${MOCK_PORT}`, "-scenario", "full"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const panel = spawn(PANEL_BINARY, ["--config", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Surfaced in the Playwright HTML report / CI logs on a startup failure
  // rather than silently swallowed — both processes' own stdout/stderr are
  // otherwise invisible once globalSetup returns.
  for (const [name, proc] of [
    ["telemt-mock", mock],
    ["telemt-panel", panel],
  ] as const) {
    proc.stdout?.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
    proc.stderr?.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  }

  try {
    // The panel's own /api/health is the readiness signal for the whole
    // stack — it only serves once its own HTTP server is up, and every
    // subsequent test call goes through the panel anyway (it proxies to
    // telemt-mock, never the other way around), so there is no separate
    // "is telemt-mock up" probe to make here.
    await waitForHealth(`${BASE_URL}/api/health`, 30_000);
  } catch (err) {
    await stopStack({ panel, mock, tmpDir });
    throw err;
  }

  return { panel, mock, tmpDir };
}

function killAndWait(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    const forceKill = setTimeout(() => proc.kill("SIGKILL"), 5_000);
    proc.once("exit", () => {
      clearTimeout(forceKill);
      resolve();
    });
    proc.kill("SIGTERM");
  });
}

// stopStack tears down both processes (SIGTERM, SIGKILL after a 5s grace)
// and removes the scratch config/binary directory — called from
// globalSetup's returned teardown function, so it always runs even if a
// test in between crashed the runner.
export async function stopStack(stack: Stack): Promise<void> {
  await Promise.all([killAndWait(stack.panel), killAndWait(stack.mock)]);
  await rm(stack.tmpDir, { recursive: true, force: true });
}
