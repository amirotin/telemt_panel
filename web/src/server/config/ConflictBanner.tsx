import { ru } from "../../i18n/ru";
import { Button } from "../../ui/Button";

// ConflictBanner — the 409 revision_conflict response: an inline banner
// listing the section.key paths that changed on the server while the admin
// was editing (06-ui.md: "конфликт ревизий — inline-diff баннер, не
// alert()"), plus a single explicit "перезагрузить и повторить" action —
// never a silent automatic discard of the in-progress edit.
export function ConflictBanner({ changedKeys, onReload }: { changedKeys: string[]; onReload: () => void }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-warn/30 bg-warn/5 p-4">
      <p className="text-sm font-medium text-warn">{ru.server.config.conflictTitle}</p>
      <p className="text-sm text-text">{ru.server.config.conflictDescription}</p>
      {changedKeys.length > 0 && (
        <p className="font-mono text-xs text-text-muted">{changedKeys.join(", ")}</p>
      )}
      <Button variant="secondary" onClick={onReload} className="self-start">
        {ru.server.config.conflictReload}
      </Button>
    </div>
  );
}
