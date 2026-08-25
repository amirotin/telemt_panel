import { cn } from "../lib/cn";
import { CopyField } from "../ui/CopyField";
import { QR } from "../ui/QR";
import { ru } from "../i18n/ru";
import { parseLink } from "./parseLink";

export interface LinkCardProps {
  label: string;
  link: string;
  /**
   * Narrow layout for the 348px Инспектор column: the parsed fields stack
   * in one column and the QR shrinks. Nothing is dropped — a link you can
   * scan on the detail screen is still scannable here.
   */
  compact?: boolean;
}

// LinkCard — one connection link, parsed into its display fields
// (server/port/secret[/domain]) plus a per-field CopyField and a QR of the
// whole link (06-ui.md §Люди: "деталка... links по-полевно"). Falls back to
// showing just the raw link when it can't be parsed (an unexpected format
// from a future Telemt version shouldn't hide the link entirely).
export function LinkCard({ label, link, compact }: LinkCardProps) {
  const parsed = parseLink(link);

  return (
    <div
      className={cn(
        "flex flex-col rounded-xl bg-surface",
        compact ? "gap-2 bg-bg p-3" : "gap-3 border border-border p-4",
      )}
    >
      <span className="text-xs font-medium text-text-muted">{label}</span>
      {parsed.type !== "unknown" ? (
        <div className={cn("grid gap-3", compact ? "grid-cols-1 gap-2" : "grid-cols-2")}>
          {parsed.server && <CopyField value={parsed.server} label={ru.people.detail.server} />}
          {parsed.port && <CopyField value={parsed.port} label={ru.people.detail.port} />}
          {parsed.secret && <CopyField value={parsed.secret} label={ru.people.detail.secret} />}
          {parsed.domain && <CopyField value={parsed.domain} label={ru.people.detail.domain} />}
        </div>
      ) : null}
      <CopyField value={link} label={ru.people.share.linkLabel} />
      <QR value={link} size={compact ? 120 : 140} className={compact ? "self-center" : undefined} />
    </div>
  );
}
