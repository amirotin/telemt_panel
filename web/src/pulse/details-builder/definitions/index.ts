// Production Details-page definitions, one module per domain (Tasks 6–8).
//
// Kept out of details-builder/index.ts on purpose: the builder is generic
// and a page definition is not part of its API — importing one from the
// builder's barrel would make every renderer's import graph reach into
// every domain.
export * from "./counters";
export * from "./dc";
export * from "./me";
export * from "./security";
