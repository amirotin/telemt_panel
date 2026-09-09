import { useQuery } from "@tanstack/react-query";
import { getHostOptions } from "../lib/api/generated/@tanstack/react-query.gen";
import { useStrings } from "../i18n";
import { IconWarning } from "../ui/icons";

export function HistoryNotice() {
  const s = useStrings();
  const host = useQuery(getHostOptions());
  if (!host.data?.history_temporary) return null;

  return (
    <details className="m-2 shrink-0 rounded-lg border border-warn/30 bg-warn/10 text-text">
      <summary className="min-h-11 cursor-pointer px-3 py-3 text-sm font-semibold focus-visible:outline-accent">
        <IconWarning className="mr-2 inline h-4 w-4 text-warn" />
        {s.shell.historyTemporary}
      </summary>
      <p className="px-3 pb-3 text-sm leading-relaxed text-text-muted">
        {s.shell.historyTemporaryHint}
      </p>
    </details>
  );
}
