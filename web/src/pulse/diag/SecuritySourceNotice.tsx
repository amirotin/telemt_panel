import { useStrings } from "../../i18n";
import { SourceNotice } from "./SourceNotice";

export function SecuritySourceNotice({ kind, onRetry }: { kind: "loading" | "error" | "unavailable"; onRetry?: () => void }) {
  const v = useStrings().details.pages.security.view;
  const title = kind === "loading" ? v.loading : kind === "error" ? v.sourceError : v.unavailable;
  const description = kind === "loading" ? v.loadingText : kind === "error" ? v.sourceErrorText : v.unavailableText;
  return <SourceNotice title={title} description={description} className="p-5" panelClassName="rounded-xl border border-dashed border-border px-5 py-10 text-center">
    {kind === "error" && onRetry && <button type="button" onClick={onRetry} className="mt-4 rounded-lg border border-border px-3 py-2 text-meta font-semibold text-text hover:border-accent/45">{v.retry}</button>}
  </SourceNotice>;
}
