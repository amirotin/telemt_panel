#!/usr/bin/env node
// Strips every path item tagged `x-status: planned` from ../../api/openapi.yaml
// before handing it to hey-api/openapi-ts, so the generated client only
// exposes routes actually registered in internal/httpapi/server.go.
// Deterministic (pure text-in/text-out, no network) — `npm run gen` commits
// the generated output, so CI never has to run this itself; see web/README.md.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import yaml from "js-yaml";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, "..", "..", "api", "openapi.yaml");
const outPath = path.join(here, "..", ".openapi-filtered.yaml");

const doc = yaml.load(readFileSync(srcPath, "utf8"));

let removed = 0;
for (const [route, item] of Object.entries(doc.paths ?? {})) {
  if (item && typeof item === "object" && item["x-status"] === "planned") {
    delete doc.paths[route];
    removed++;
  }
}

writeFileSync(outPath, yaml.dump(doc, { noRefs: true, lineWidth: -1 }));
console.log(`filter-openapi: wrote ${outPath} (${removed} planned path(s) excluded)`);
