import { ru } from "../../i18n/ru";
import { Button } from "../../ui/Button";

export interface ConflictBannerProps {
  changedKeys: string[];
  /** "section.key" paths where the admin's own pending edit and the server's own change collide — [] means the reapply is safe with no explicit confirmation. */
  overlapping: string[];
  pending: boolean;
  /** Rebase onto the fresh revision and reapply the admin's pending patch on top — safe (and auto-retried) when `overlapping` is empty; requires the admin's explicit choice otherwise. */
  onReapply: () => void;
  /** Discard the admin's pending edits entirely and reset to the fresh server state — only ever offered when `overlapping` is non-empty. */
  onDiscard: () => void;
}

// ConflictBanner — the 409 revision_conflict response: an inline banner
// listing the section.key paths that changed on the server while the admin
// was editing (06-ui.md: "конфликт ревизий — inline-diff баннер, не
// alert()"). Never silently discards the admin's in-progress edit
// (rebaseEdits.ts computes the rebase): when the admin's own changed keys
// don't overlap with what changed server-side, a single "перезагрузить и
// повторить" rebases onto the fresh revision, reapplies the pending patch,
// and retries the PATCH automatically. When they DO overlap, the choice is
// explicit — reapply the admin's edit anyway (admin's value wins) or
// discard it (server's value wins) — with honest labels: "discard" never
// claims to "retry" anything, since nothing of the admin's is being sent.
export function ConflictBanner({ changedKeys, overlapping, pending, onReapply, onDiscard }: ConflictBannerProps) {
  const hasOverlap = overlapping.length > 0;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-warn/30 bg-warn/5 p-4">
      <p className="text-sm font-medium text-warn">{ru.server.config.conflictTitle}</p>
      <p className="text-sm text-text">{ru.server.config.conflictDescription}</p>
      {changedKeys.length > 0 && <p className="font-mono text-xs text-text-muted">{changedKeys.join(", ")}</p>}

      {hasOverlap ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-error">
            {ru.server.config.conflictOverlapWarning}: {overlapping.join(", ")}
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onDiscard} disabled={pending} className="flex-1">
              {ru.server.config.conflictDiscardMine}
            </Button>
            <Button variant="primary" onClick={onReapply} disabled={pending} className="flex-1">
              {ru.server.config.conflictReapplyMine}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="secondary" onClick={onReapply} disabled={pending} className="self-start">
          {ru.server.config.conflictReload}
        </Button>
      )}
    </div>
  );
}
