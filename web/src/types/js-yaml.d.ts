// js-yaml ships no types of its own and @types/js-yaml isn't installed —
// this is the minimal ambient declaration for the one function this
// project actually calls (scripts/filter-openapi.mjs, src/i18n/ru.test.ts),
// rather than pulling in a types-only devDependency for it.
declare module "js-yaml" {
  interface YamlModule {
    load(input: string): unknown;
  }
  const yaml: YamlModule;
  export default yaml;
}
