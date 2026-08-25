import { defineConfig } from "@hey-api/openapi-ts";

// `npm run gen` runs scripts/filter-openapi.mjs first (see package.json),
// which strips every `x-status: planned` path from api/openapi.yaml into
// .openapi-filtered.yaml — this config reads that filtered copy so the
// generated client never exposes a route the server doesn't register yet.
//
// Generated output is committed (src/lib/api/generated) rather than
// regenerated in CI: the contract only changes when a human edits
// api/openapi.yaml and deliberately reruns `npm run gen`, so a CI-diff
// gate would just be a slower, flakier version of code review catching a
// stale commit. Documented in web/README.md.
export default defineConfig({
  input: "./.openapi-filtered.yaml",
  output: {
    path: "./src/lib/api/generated",
    clean: true,
  },
  plugins: [
    "@hey-api/client-fetch",
    "@hey-api/typescript",
    "@hey-api/sdk",
    {
      name: "@tanstack/react-query",
      queryOptions: true,
    },
  ],
});
