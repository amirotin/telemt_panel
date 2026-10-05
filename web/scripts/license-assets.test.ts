import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "vite";
import { compressedAssets } from "./compress-assets.ts";
import { licenseAssets } from "./license-assets.ts";
import { gunzipSync } from "node:zlib";

const temporary: string[] = [];
afterEach(() => { temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });

describe("embedded license build assets", () => {
  it("copies root notices through compression without bundling executable content", async () => {
    const directory = mkdtempSync(join(tmpdir(), "panel-license-assets-"));
    temporary.push(directory);
    const root = join(directory, "web");
    mkdirSync(root);
    writeFileSync(join(directory, "LICENSE"), "Project license permissions\n");
    writeFileSync(join(directory, "THIRD_PARTY_NOTICES.md"), "Third-party attribution\n");
    writeFileSync(join(root, "index.html"), '<html><head></head><body><script type="module" src="./entry.js"></script></body></html>');
    writeFileSync(join(root, "entry.js"), "console.log('fixture');");
    await build({ root, configFile: false, logLevel: "silent", plugins: [licenseAssets(), compressedAssets()], build: { outDir: "dist" } });
    for (const [asset, source] of [["LICENSE.txt", "LICENSE"], ["THIRD_PARTY_NOTICES.txt", "THIRD_PARTY_NOTICES.md"]]) {
      const packed = readFileSync(join(root, "dist/licenses", asset + ".gz"));
      expect(gunzipSync(packed).toString()).toBe(readFileSync(join(directory, source), "utf8"));
    }
  });

  it("fails a build when its root license source is missing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "panel-license-missing-"));
    temporary.push(directory);
    const root = join(directory, "web");
    mkdirSync(root);
    writeFileSync(join(root, "index.html"), "<html></html>");
    writeFileSync(join(directory, "THIRD_PARTY_NOTICES.md"), "Attribution\n");
    await expect(build({ root, configFile: false, logLevel: "silent", plugins: [licenseAssets()] })).rejects.toThrow();
  });

  it("requires a versioned notice for each retained third-party module", async () => {
    const directory = mkdtempSync(join(tmpdir(), "panel-license-package-"));
    temporary.push(directory);
    const root = join(directory, "web");
    const dependency = join(root, "node_modules/fixture-lib");
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(directory, "LICENSE"), "Project license\n");
    writeFileSync(join(directory, "THIRD_PARTY_NOTICES.md"), "Unrelated package notices\n");
    writeFileSync(join(dependency, "package.json"), JSON.stringify({ name: "fixture-lib", version: "1.2.3", type: "module", exports: "./index.js" }));
    writeFileSync(join(dependency, "index.js"), "export const value = 'retained dependency';");
    writeFileSync(join(root, "index.html"), '<html><script type="module" src="./entry.js"></script></html>');
    writeFileSync(join(root, "entry.js"), "import {value} from 'fixture-lib'; console.log(value);");
    await expect(build({ root, configFile: false, logLevel: "silent", plugins: [licenseAssets()] })).rejects.toThrow("fixture-lib@1.2.3");
  });
});
