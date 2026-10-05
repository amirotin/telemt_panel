import { CORE_SCHEMA, load, mergeTag } from "js-yaml";

const schema = CORE_SCHEMA.withTags(mergeTag);

// Keep YAML 1.2 scalars and the merge syntax used by OpenAPI documents,
// with the same bounded merge work across production tooling and tests.
export function loadOpenAPIYaml(input, maxTotalMergeKeys = 10_000) {
  return load(input, { schema, maxTotalMergeKeys });
}
