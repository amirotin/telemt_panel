import { useState } from 'react';
import { CopyButton } from '@/components/CopyButton';

export interface ProxyLink {
  url: string;     // full tg://proxy link, with the `comment` already appended
  domain: string;  // display label: masking domain, or the real server for the default
  isDefault: boolean;
}

export interface ProxyLinkGroup {
  label: string;
  links: ProxyLink[];
}

function ProxyLinkGroupButtons({ group }: { group: ProxyLinkGroup }) {
  const [idx, setIdx] = useState(0);
  const selected = group.links[Math.min(idx, group.links.length - 1)];
  const showDomainSelect = (group.label === 'TLS' || group.label === 'WEB') && group.links.length > 1;
  // tg://webproxy has no t.me equivalent (Telegram Desktop-only scheme).
  const isWebProxy = selected.url.startsWith('tg://webproxy');

  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className="flex items-center gap-1">
        <CopyButton text={selected.url} label={group.label} />
        {!isWebProxy && (
          <CopyButton text={selected.url.replace('tg://proxy', 'https://t.me/proxy')} label="t.me" />
        )}
      </div>
      {showDomainSelect && (
        <select
          value={idx}
          onChange={(e) => setIdx(Number(e.target.value))}
          aria-label="Select TLS proxy domain"
          className="max-w-[200px] min-w-0 truncate rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-text-primary focus:border-accent focus:outline-none"
        >
          {group.links.map((l, i) => (
            <option key={i} value={i}>
              {l.isDefault ? `${l.domain} (default)` : l.domain}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

export function ProxyLinkButtons({ links }: { links: ProxyLinkGroup[] }) {
  if (links.length === 0) {
    return <span className="text-text-secondary text-xs">No links</span>;
  }
  return (
    <div className="flex flex-col items-start gap-2">
      {links.map((group) => (
        <ProxyLinkGroupButtons key={group.label} group={group} />
      ))}
    </div>
  );
}
