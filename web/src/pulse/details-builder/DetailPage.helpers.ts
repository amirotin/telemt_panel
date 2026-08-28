// Pure section-list helpers for DetailPage — colocated in a `.helpers.ts`
// the way every other non-trivial page in this repo splits its logic out
// (and so the component file exports only components).

import type { TabDefinition } from "./model";
import type { SectionInstance } from "./resolveSections";

// withUnknownTail appends the leftover tail as the last section, so the
// §27.4 equation's third term is ON SCREEN and not merely computed.
export function withUnknownTail(
  sections: readonly SectionInstance[],
  tail: SectionInstance | null,
): SectionInstance[] {
  return tail === null ? [...sections] : [...sections, tail];
}

// sectionsForTab implements TabDefinition's contract: a tab lists the
// section ids it owns, and a tab with no list takes everything no other tab
// claimed.
export function sectionsForTab(
  sections: readonly SectionInstance[],
  tabs: readonly TabDefinition[],
  activeId: string | undefined,
): SectionInstance[] {
  const tab = tabs.find((t) => t.id === activeId) ?? tabs[0];
  if (tab === undefined) return [...sections];
  if (tab.sections && tab.sections.length > 0) {
    const wanted = new Set(tab.sections);
    return sections.filter((section) => wanted.has(section.id));
  }
  const claimed = new Set(tabs.flatMap((t) => t.sections ?? []));
  return sections.filter((section) => !claimed.has(section.id));
}
