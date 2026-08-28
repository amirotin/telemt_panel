import { useState } from "react";
import { useStrings } from "../../../i18n";
import { Button } from "../../../ui/Button";
import type { UnknownFieldsSectionInstance } from "../resolveSections";
import { SectionFrame } from "./SectionFrame";
import { EmptyNote, NodeList } from "./NodeTree";
import { isSectionExpanded, type DetailRenderContext } from "./context";

export interface UnknownFieldsSectionProps {
  instance: UnknownFieldsSectionInstance;
  ctx: DetailRenderContext;
  /** The raw payload behind the tail, for the §24.1 last-level JSON fallback. */
  raw?: unknown;
}

// UnknownFieldsSection renders the leftover tail (§11.3, §24.1) as the
// recursive accordion the spec asks for: object → nested group, array →
// its own block, scalar → a described row — never a flattened dump.
//
// Closed by default, and (ruling R2) only present at all in `extended`
// display mode; the section list applies that filter through `showsAtMode`,
// so this component does not repeat the check.
//
// The last level is the raw JSON dump §24.1 permits, revealed on request.
// pulse/diag/rows.ts's `flattenToRows` is deliberately NOT used: it
// comma-joins primitive arrays and renders empty containers as an em dash,
// which §10.1 and §10.3 forbid.
export function UnknownFieldsSection({ instance, ctx, raw }: UnknownFieldsSectionProps) {
  const s = useStrings();
  const [rawOpen, setRawOpen] = useState(false);
  const expanded = isSectionExpanded(instance.id, instance.defaultExpanded, ctx.expandedSections);

  return (
    <SectionFrame
      id={instance.id}
      title={instance.title(s)}
      description={instance.description?.(s)}
      count={instance.leafPaths.length}
      expanded={expanded}
      onToggle={() => ctx.toggleSection(instance.id)}
    >
      {instance.nodes.length === 0 ? (
        <EmptyNote text={s.details.unknown.none} />
      ) : (
        <NodeList nodes={instance.nodes} ctx={ctx} />
      )}
      {instance.rawJson && raw !== undefined && (
        <div className="flex flex-col gap-2 py-3">
          <Button variant="secondary" size="sm" onClick={() => setRawOpen((v) => !v)}>
            {rawOpen ? s.details.unknown.hideJson : s.details.unknown.rawJson}
          </Button>
          {rawOpen && (
            <pre className="max-h-96 overflow-auto rounded-md bg-bg p-3 font-mono text-micro text-text-muted">
              {JSON.stringify(raw, null, 2)}
            </pre>
          )}
        </div>
      )}
    </SectionFrame>
  );
}
