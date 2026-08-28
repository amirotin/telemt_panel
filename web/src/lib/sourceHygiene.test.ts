// A source file has to stay TEXT, and nothing else in the toolchain checks
// that it did. A raw NUL byte inside a string literal is valid TypeScript:
// eslint, tsc, vitest and the build all pass over it. Git, however, then
// classifies the file as binary — its diff vanishes from review, `git grep`
// stops finding the symbols declared in it, and blame goes with them. It
// has happened twice already (fieldCatalog.ts, ranking.helpers.ts), both
// times where an escape sequence was meant, so this sweep is the guard.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// vitest runs from the directory holding its config, which is `web/`;
// `import.meta.url` is not a file URL here because vite rewrites it.
const SRC_DIR = join(process.cwd(), "src");
const EXTENSIONS = [".ts", ".tsx", ".css"];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (EXTENSIONS.some((extension) => entry.name.endsWith(extension))) out.push(path);
  }
  return out;
}

describe("source hygiene", () => {
  it("keeps every source file free of a raw NUL byte", () => {
    const files = sourceFiles(SRC_DIR);
    // A sweep that walked nothing would pass forever; pin that it walked
    // the tree, without pinning a count that grows with every feature.
    expect(files.length).toBeGreaterThan(200);
    const offenders = files
      .filter((path) => readFileSync(path).includes(0))
      .map((path) => path.slice(SRC_DIR.length + 1));
    expect(offenders).toEqual([]);
  });
});
