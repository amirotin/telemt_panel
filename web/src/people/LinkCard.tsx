import { CopyField } from "../ui/CopyField";
import { QR } from "../ui/QR";
import { ru } from "../i18n/ru";
import { parseLink } from "./parseLink";

// LinkCard — one connection link, parsed into its display fields
// (server/port/secret[/domain]) plus a per-field CopyField and a QR of the
// whole link (06-ui.md §Люди: "деталка... links по-полевно"). Falls back to
// showing just the raw link when it can't be parsed (an unexpected format
// from a future Telemt version shouldn't hide the link entirely).
export function LinkCard({ label, link }: { label: string; link: string }) {
  const parsed = parseLink(link);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
      <span className="text-xs font-medium text-text-muted">{label}</span>
      {parsed.type !== "unknown" ? (
        <div className="grid grid-cols-2 gap-3">
          {parsed.server && <CopyField value={parsed.server} label={ru.people.detail.server} />}
          {parsed.port && <CopyField value={parsed.port} label={ru.people.detail.port} />}
          {parsed.secret && <CopyField value={parsed.secret} label={ru.people.detail.secret} />}
          {parsed.domain && <CopyField value={parsed.domain} label={ru.people.detail.domain} />}
        </div>
      ) : null}
      <CopyField value={link} label={ru.people.share.linkLabel} />
      <QR value={link} size={140} />
    </div>
  );
}
