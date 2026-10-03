import { useState } from "react";
import { formatNumber, type Dict } from "../../i18n";
import { HelpHint } from "../../ui/HelpHint";
import type { WebPagePayload } from "./web.helpers";

function groupFor(reason: string): "capacity" | "rate" | "access" | "other" {
  if (reason.endsWith("_capacity") || reason === "stream_tuple_exhausted") return "capacity";
  if (reason.endsWith("_rate")) return "rate";
  if (reason.startsWith("operator_") || reason.startsWith("generation_") || ["config_disabled", "user_disabled", "runtime_closed"].includes(reason)) return "access";
  return "other";
}

export function WebRejections({ payload, s }: { payload: WebPagePayload; s: Dict }) {
  const [expanded, setExpanded] = useState(false);
  const v = s.details.pages.web.view;
  if (!payload.capacity) return null;
  const causes = payload.capacity.rejections.filter(cause => Number.isFinite(cause.total) && cause.total > 0).sort((a, b) => b.total - a.total);
  const shown = expanded ? causes : causes.slice(0, 6);
  const labels = v.rejectionReasons as Record<string, string>;
  return <section className="mt-5 border-t border-border pt-3" data-testid="web-rejections">
    <header className="flex items-center justify-between gap-2">
      <h4 className="flex items-center text-meta font-semibold text-text">{v.rejectionCauses}<HelpHint label={v.rejectionCauses}>{v.rejectionCausesNote}</HelpHint></h4>
      <span className="text-micro text-text-muted">{v.sinceStart}</span>
    </header>
    {causes.length === 0 ? <p className="text-meta text-text-muted">{v.noDetailedRejections}</p> : <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {(["capacity", "rate", "access", "other"] as const).map(group => {
        const rows = shown.filter(cause => groupFor(cause.reason) === group);
        if (!rows.length) return null;
        return <div key={group} data-web-rejection-group={group}>
          <h5 className="mb-1 text-micro font-semibold text-text-faint">{v.rejectionGroups[group]}</h5>
          <dl>{rows.map(cause => <div key={cause.reason} className="flex min-w-0 justify-between gap-3 border-b border-border/50 py-2 text-meta" data-web-rejection={cause.reason}>
            <dt className="text-text-muted">{labels[cause.reason] ?? cause.reason}</dt><dd className="shrink-0 font-mono tabular-nums text-text">{formatNumber(s, cause.total)}</dd>
          </div>)}</dl>
        </div>;
      })}
    </div>}
    {causes.length > 6 && <button type="button" className="mt-2 min-h-11 text-meta font-semibold text-accent" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? v.hideRejections : v.showRejections} · {formatNumber(s, causes.length)}</button>}
  </section>;
}
