import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

// Root source texts are copied by the build; generated dist files are disposable.
export function licenseAssets(): Plugin {
  let root: string;
  let notices: string;
  return {
    name: "license-assets",
    apply: "build",
    configResolved(config) { root = config.root; },
    buildStart() {
      notices = readFileSync(resolve(root, "../THIRD_PARTY_NOTICES.md"), "utf8");
      this.emitFile({ type: "asset", fileName: "licenses/LICENSE.txt", source: readFileSync(resolve(root, "../LICENSE"), "utf8") });
      this.emitFile({ type: "asset", fileName: "licenses/THIRD_PARTY_NOTICES.txt", source: notices });
    },
    generateBundle(_options, bundle) {
      const checked = new Set<string>();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const id of chunk.moduleIds ?? Object.keys(chunk.modules)) {
          const normalized = id.replaceAll("\\", "/");
          const position = normalized.lastIndexOf("/node_modules/");
          if (position < 0) continue;
          const tail = normalized.slice(position + "/node_modules/".length).split("/");
          const count = tail[0].startsWith("@") ? 2 : 1;
          const directory = normalized.slice(0, position + "/node_modules/".length) + tail.slice(0, count).join("/");
          if (checked.has(directory)) continue;
          checked.add(directory);
          const metadata = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8")) as { name: string; version: string };
          if (!notices.includes(`${metadata.name}@${metadata.version}`)) {
            this.error(`Missing third-party notice for shipped ${metadata.name}@${metadata.version}; update root THIRD_PARTY_NOTICES.md`);
          }
        }
      }
    },
  };
}
