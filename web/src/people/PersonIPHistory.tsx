import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getUserIpHistoryOptions } from "../lib/api/generated/@tanstack/react-query.gen";
import type { UserIpHistory } from "../lib/api/generated/types.gen";
import { fill, localeOf, useStrings } from "../i18n";
import { Button } from "../ui/Button";
import { Sheet } from "../ui/Sheet";
import { Skeleton } from "../ui/Skeleton";
import { useNow } from "./useNow";
import { withBasePath } from "../lib/base-path";
import { IPGeography } from "./IPGeography";
import "./ipHistory.css";

const PAGE_SIZE = 10;
type Family = "all" | "4" | "6";
type Range = UserIpHistory["range"];

export function PersonIPHistoryEntry({ username }: { username: string }) {
  const s = useStrings().people.ipHistory;
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return <>
    <button type="button" className="person-ip-entry" onClick={() => setOpen(true)} aria-haspopup="dialog">
      <span><strong>{s.title}</strong><small>{s.subtitle}</small></span><span aria-hidden="true">→</span>
    </button>
    <Sheet open={open} onClose={close} title={s.title} eyebrow={username} placement="form"
      className="person-ip-sheet" headerClassName="person-ip-heading" bodyClassName="person-ip-body">
      {open && <PersonIPHistory username={username} />}
    </Sheet>
  </>;
}

// Identity changes must reset filters and pagination as well as the query key.
export function PersonIPHistory({ username }: { username: string }) {
  return <HistoryContent key={username} username={username} />;
}

function HistoryContent({ username }: { username: string }) {
  const strings = useStrings();
  const s = strings.people.ipHistory;
  const locale = localeOf(strings);
  const client = useQueryClient();
  const now = useNow(1000);
  const [filters, setFilters] = useState({ range: "30d" as Range, family: "all" as Family, q: "" });
  const [cursors, setCursors] = useState([""]);
  const cursor = cursors[cursors.length - 1];
  const query = useQuery({
    ...getUserIpHistoryOptions({ path: { username }, query: { ...filters, limit: PAGE_SIZE, cursor } }),
    // Do not shuffle later pages under the reader while they inspect history.
    refetchInterval: cursor ? false : 15_000,
    staleTime: 10_000,
  });
  const data = query.data;
  const hasGeo = data?.geoip?.available === true;
  // Server-relative age avoids requiring synchronized browser/server clocks.
  const age = data?.source.age_secs == null ? Infinity
    : data.source.age_secs + Math.max(0, now - query.dataUpdatedAt) / 1000;
  const live = !!data && !query.isError && data.source.state === "collecting" && age >= 0 && age <= 30;
  const active = live ? data?.active_now_count : null;
  function filter(patch: Partial<typeof filters>) {
    setFilters(previous => ({ ...previous, ...patch }));
    setCursors([""]);
  }
  function refresh() {
    setCursors([""]);
    void client.invalidateQueries({
      queryKey: getUserIpHistoryOptions({ path: { username }, query: { ...filters, limit: PAGE_SIZE, cursor: "" } }).queryKey,
      exact: true,
    });
  }
  const number = (value: number | null | undefined) => value == null ? "—" : value.toLocaleString(locale);
  const date = (timestamp: number, label: string) => {
    const value = new Date(timestamp * 1000);
    return <div className="person-ip-date"><span className="person-ip-mobile-label">{label}</span>
      <time dateTime={value.toISOString()} title={value.toLocaleString(locale)}>
        {new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(value)}
        <small>{new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(value)}</small>
      </time></div>;
  };
  const notes: string[] = [];
  if (data) {
    notes.push(live ? s.collecting : s.unavailable);
    notes.push(data.durable ? fill(s.retention, { days: data.retention_days }) : s.memory);
    if (data.source.recent_window_secs != null) notes.push(fill(s.window, { seconds: data.source.recent_window_secs }));
    if (data.source.pending) notes.push(s.pending);
    if (data.source.history_limited || data.collection.history_limited) notes.push(s.limited);
    if (data.source.collection_gap || data.collection.collection_gap) notes.push(s.gap);
  }
  return <section className={`person-ip-history${hasGeo ? " person-ip-has-geo" : ""}`} aria-label={s.title}>
    <div className="person-ip-overview">
      <div><strong>{number(data?.total)}</strong><span>{s.total}</span></div>
      <div><strong data-active-count>{number(active)}</strong><span>{s.active}</span></div>
      <div><strong>{number(filters.range === "all" ? null : data?.new)}</strong><span>{s.new}</span></div>
    </div>
    <p className="person-ip-collection" data-tone={data && !live ? "warning" : undefined}>{notes.join(" · ") || (query.isError ? s.error : s.loading)}</p>
    {data && <p className="person-ip-geo-note">{hasGeo ? strings.geoip.activeNote : <>{strings.geoip.noDatabase} <a data-geoip-configure href={withBasePath("/server/settings#geoip")}>{strings.geoip.configure} →</a></>}</p>}
    <div className="person-ip-tools">
      <label className="person-ip-search"><span className="sr-only">{s.search}</span>
        <input type="search" value={filters.q} maxLength={64} placeholder={s.search} autoComplete="off" spellCheck={false}
          onChange={event => filter({ q: event.target.value })} />
      </label>
      <label><span>{s.period}</span><select value={filters.range} onChange={event => filter({ range: event.target.value as Range })}>
        {(["24h", "7d", "30d", "all"] as const).map(range => <option key={range} value={range}>{s.ranges[range]}</option>)}
      </select></label>
      <label><span>{s.family}</span><select data-family value={filters.family} onChange={event => filter({ family: event.target.value as Family })}>
        <option value="all">IPv4 + IPv6</option><option value="4">IPv4</option><option value="6">IPv6</option>
      </select></label>
      <Button type="button" variant="secondary" disabled={query.isFetching} onClick={refresh}>{s.refresh}</Button>
    </div>
    <div className="person-ip-columns" aria-hidden="true"><span>{s.address}</span>{hasGeo && <span>{strings.geoip.geography}</span>}<span>{s.first}</span><span>{s.last}</span></div>
    <div role="list" aria-label={s.addresses} aria-busy={query.isFetching}>
      {query.isPending ? <div className="person-ip-empty"><Skeleton className="h-36 w-full rounded-lg" /></div>
        : !data ? <div className="person-ip-empty" role="alert"><strong>{s.error}</strong><p>{s.retry}</p></div>
          : data.items.length === 0 ? <div className="person-ip-empty"><strong>{data.total ? s.noMatches : s.empty}</strong><p>{data.total ? s.noMatchesHint : s.emptyHint}</p></div>
            : data.items.map(item => <div key={item.ip} className="person-ip-row" data-ip-row role="listitem">
              <div className="person-ip-address"><strong>{item.ip}</strong><div className="person-ip-address-meta">
                <span>IPv{item.family}</span><span data-ip-state={live && item.active_now ? "active" : "history"}>
                  {!live || item.active_now == null ? s.unknown : item.active_now ? s.connected : s.observed}
                </span>
              </div></div>{hasGeo && <IPGeography geo={item.geo} />}{date(item.first_observed_at, s.first)}{date(item.last_observed_at, s.last)}
            </div>)}
    </div>
    <footer className="person-ip-pagination">
      <span role="status">{data ? fill(s.page, {
        from: number(data.items.length ? (cursors.length - 1) * PAGE_SIZE + 1 : 0),
        to: number(data.items.length ? (cursors.length - 1) * PAGE_SIZE + data.items.length : 0), total: number(data.matched),
      }) : "—"}</span>
      <div><Button type="button" variant="secondary" data-previous disabled={cursors.length === 1 || query.isFetching}
        onClick={() => setCursors(previous => previous.slice(0, -1))}>{s.previous}</Button>
        <Button type="button" variant="secondary" data-next disabled={!data?.next_cursor || query.isFetching}
          onClick={() => { if (data?.next_cursor) setCursors(previous => [...previous, data.next_cursor]); }}>{s.next}</Button></div>
    </footer>
    <aside className="person-ip-explanation"><p>{s.explanation}</p><p>{s.observations}</p></aside>
  </section>;
}
