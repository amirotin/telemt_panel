// The Details-page builder's public surface. Renderers (Task 3/4) and page
// definitions (Tasks 6–8) import from here, not from the individual
// modules, so the split between model/resolver/catalog/formatting stays an
// implementation detail.
export * from "./model";
export * from "./paths";
export * from "./formatting";
export * from "./fieldCatalog";
export * from "./resolveSections";
export * from "./sources";
export * from "./state";
