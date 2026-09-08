import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import type { Plugin } from "vite";

// The Go server negotiates gzip/identity at the original URLs. Keep only gzip
// for scripts/styles in dist so go:embed never includes duplicate originals.
export function compressedAssets(): Plugin {
  let outDir: string;
  return {
    name: "compressed-assets",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      for (const entry of readdirSync(outDir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !/\.(js|css)$/.test(entry.name)) continue;
        const file = join(entry.parentPath, entry.name);
        writeFileSync(`${file}.gz`, gzipSync(readFileSync(file), { level: 9 }));
        unlinkSync(file);
      }
    },
  };
}
