import type { ReactNode } from "react";
import { cn } from "../../../lib/cn";
import { CountBadge } from "../../../ui/Chip";
import { IconChevronDown, IconChevronUp } from "../../../ui/icons";

export interface SectionFrameProps {
  /** Section id — the panel's DOM id, referenced by the header's aria-controls. */
  id: string;
  title: ReactNode;
  description?: ReactNode;
  /** Element count shown in the header badge. A badge NEVER replaces content (§10). */
  count?: number;
  /** Extra header content on the value side — a Σ, a state pill. */
  trailing?: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  /** A section that is always open (no chevron, no button). */
  collapsible?: boolean;
  /** Nested blocks (a record's child array) sit on the sunken surface, not on a card. */
  nested?: boolean;
  children: ReactNode;
  className?: string;
}

// SectionFrame is the one accordion shell every Details section renders
// inside: title + optional count badge + always-visible description, a
// chevron, and a panel that is genuinely removed from the a11y tree while
// collapsed. `aria-expanded` + `aria-controls` on a real <button> is the
// whole keyboard/screen-reader contract (§21); the header is a 44px tap
// target (§16.4).
export function SectionFrame({
  id,
  title,
  description,
  count,
  trailing,
  expanded,
  onToggle,
  collapsible = true,
  nested = false,
  children,
  className,
}: SectionFrameProps) {
  const panelId = `${id}-panel`;
  const header = (
    <div className="flex min-w-0 flex-1 flex-col items-start text-left">
      {/* L9 (Task 4/5 reviews): on 360 px the badge first squeezed a long
          title into breaking mid-token, and then — once the row wrapped —
          landed on a line of its own, reading as a stray digit between the
          header and the rows. It is text, so it flows AS text: inside the
          title's own inline box it follows the last fragment of the name
          and can never be orphaned while that fragment has room beside it. */}
      <span
        className={cn(
          "block min-w-0 max-w-full break-words font-semibold text-text",
          nested ? "font-mono text-[12.5px]" : "text-[15px]",
        )}
      >
        {title}
        {count !== undefined && (
          <CountBadge tone="muted" className="ml-2">
            {count}
          </CountBadge>
        )}
      </span>
      {description !== undefined && description !== "" && (
        <span className="mt-0.5 break-words text-meta text-text-muted">{description}</span>
      )}
    </div>
  );

  return (
    <section
      className={cn(
        "overflow-hidden",
        nested ? "rounded-lg bg-bg" : "rounded-xl bg-surface",
        className,
      )}
    >
      {collapsible ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={panelId}
          className="tap-target flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-2"
        >
          {header}
          <span className="flex shrink-0 items-center gap-2 pt-0.5 text-meta text-text-muted">
            {trailing}
            <span aria-hidden="true">{expanded ? <IconChevronUp /> : <IconChevronDown />}</span>
          </span>
        </button>
      ) : (
        <div className="flex w-full items-start gap-3 px-4 py-3">
          {header}
          {trailing !== undefined && (
            <span className="shrink-0 pt-0.5 text-meta text-text-muted">{trailing}</span>
          )}
        </div>
      )}
      <div id={panelId} hidden={!expanded} className="px-4 pb-1">
        {children}
      </div>
    </section>
  );
}
