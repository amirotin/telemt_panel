import { useState } from "react";
import { useStrings } from "../../i18n";
import { Input } from "../../ui/Input";
import { webVhostDomains } from "./webVhost.helpers";

export function WebDomainsField({ vhost, path, advanced = false, onChange }: {
  vhost: Record<string, unknown>;
  path: string;
  advanced?: boolean;
  onChange: (vhost: Record<string, unknown>) => void;
}) {
  const copy = useStrings().server.config.catalog;
  const source = JSON.stringify([vhost["host"], vhost["hosts"]]);
  const [draft, setDraft] = useState({ source, text: webVhostDomains(vhost).join(", ") });
  if (draft.source !== source) setDraft({ source, text: webVhostDomains(vhost).join(", ") });
  return (
    <label className="grid min-h-[74px] gap-2 border-b border-border/75 py-3.5 sm:grid-cols-[minmax(180px,1fr)_minmax(170px,225px)] sm:items-center sm:gap-4">
      <span className="min-w-0">
        <strong className="text-sm font-semibold text-text">{copy.webDomains}</strong>
        <span className="mt-1 block text-meta leading-relaxed text-text-muted">{copy.webDomainsHint}</span>
        {advanced && <code className="mt-1 block break-all font-mono text-micro text-accent/80">{path}.{Array.isArray(vhost["hosts"]) ? "hosts" : "host"}</code>}
      </span>
      <Input value={draft.text} placeholder="one.example.com, two.example.com" autoCapitalize="off" spellCheck={false} aria-label={copy.webDomains} onChange={(event) => {
        const text = event.target.value;
        const hosts = text.split(",").map((host) => host.trim()).filter(Boolean);
        const next = { ...vhost };
        delete next["host"];
        delete next["hosts"];
        if (hosts.length > 1) next["hosts"] = hosts;
        else next["host"] = hosts[0] ?? "";
        setDraft({ source: JSON.stringify([next["host"], next["hosts"]]), text });
        onChange(next);
      }} />
    </label>
  );
}
