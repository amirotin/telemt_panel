// SECTION_ORDER is the order the raw config view presents Telemt's
// editable sections in: roughly the order they appear in a stock
// config.toml (identity and behaviour first, transport policy after,
// listeners and the WEB mode last), not the arbitrary key order the JSON
// response happens to carry. `web` is last because it is both the newest
// section (Telemt 3.5.3+) and the biggest one.
const SECTION_ORDER = [
  "general",
  "timeouts",
  "censorship",
  "upstreams",
  "dc_overrides",
  "server",
  "web",
] as const;

// orderSections sorts config section names for display: the known sections
// above in their fixed order, then anything else alphabetically. The tail
// is what keeps a section a newer Telemt adds visible instead of missing —
// the panel passes unknown sections through end to end
// (internal/telemt/types_config.go), so the editor has to be able to show
// one it has never heard of, in a stable place rather than wherever the
// JSON happened to put it.
export function orderSections(keys: readonly string[]): string[] {
  const known = SECTION_ORDER.filter((name) => keys.includes(name));
  const unknown = keys
    .filter((name) => !(SECTION_ORDER as readonly string[]).includes(name))
    .sort();
  return [...known, ...unknown];
}

// orderedSections rebuilds a sections object with its keys in
// orderSections' order — values are carried over untouched (same
// references, no clone of the section bodies), so this only decides what
// JSON.stringify emits first, never what the config contains.
export function orderedSections(
  sections: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of orderSections(Object.keys(sections))) {
    out[name] = sections[name];
  }
  return out;
}
