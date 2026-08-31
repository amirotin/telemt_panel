import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { fill, formatNumber, useStrings, type Dict } from "../../i18n";
import type { TlsFingerprintRow, TlsFingerprints } from "../../lib/api/generated/types.gen";
import { cn } from "../../lib/cn";
import { useNow } from "../../people/useNow";
import { useSnapshot } from "../../realtime";
import type { EffectiveLimits, SecurityPosture, SecurityTopic, SecurityWhitelist } from "../../realtime/topics";
import { GatedNote } from "../GatedNote";
import { DetailHeader } from "../details-builder/DetailHeader";
import { securityPageDefinition } from "../details-builder/definitions/security";
import { useDetailSources, type DetailSourceInput, type SourceState } from "../details-builder/sources";
import { useTlsFingerprintsQuery } from "../widgets/useTlsFingerprints";
import { securityPageData } from "./security.helpers";
import {
  filterTlsRows,
  securityLevel,
  tlsRowIdentity,
  tlsRowSecondary,
  tlsTotals,
  type SecurityLevel,
  type SecurityTlsScope,
} from "./security.view.helpers";

type SecurityTab = "posture" | "tls" | "limits";

const levelStyles: Record<SecurityLevel, { border: string; mark: string; text: string }> = {
  ok: { border: "border-success/35", mark: "border-success/35 bg-gradient-to-br from-success/30 to-success/10 text-success-text", text: "text-success-text" },
  warn: { border: "border-warning/40", mark: "border-warning/45 bg-gradient-to-br from-warning/30 to-warning/10 text-warning-text", text: "text-warning-text" },
  error: { border: "border-error/45", mark: "border-error/45 bg-gradient-to-br from-error/30 to-error/10 text-error-text", text: "text-error-text" },
};

function displayNumber(s: Dict, value: number | null): string {
  return value === null ? "—" : formatNumber(s, value);
}

function duration(s: Dict, seconds: number): string {
  if (seconds >= 60 && seconds % 60 === 0) return fill(s.details.pages.security.view.minutes, { count: formatNumber(s, seconds / 60) });
  return fill(s.details.pages.security.view.seconds, { count: formatNumber(s, seconds) });
}

function SectionHead({ kicker, title, meta }: { kicker: string; title: string; meta?: string }) {
  return <header className="flex flex-wrap items-end justify-between gap-2"><div><span className="text-micro font-semibold uppercase tracking-[0.16em] text-text-faint">{kicker}</span><h2 className="mt-1 text-h2 font-semibold text-text">{title}</h2></div>{meta && <span className="text-meta text-text-muted">{meta}</span>}</header>;
}

function SecurityHero({ posture, tls }: { posture: SecurityPosture | null | undefined; tls: TlsFingerprints | undefined }) {
  const s = useStrings();
  const v = s.details.pages.security.view;
  const totals = tlsTotals(tls?.by_fingerprint);
  const level = posture ? securityLevel(posture, totals.bad) : "warn";
  const open = posture !== null && posture !== undefined && !posture.api_whitelist_enabled && !posture.api_auth_header_enabled && !posture.api_read_only;
  const verdict = !posture ? v.verdictUnknown : open ? v.verdictOpen : totals.bad !== null && totals.bad > 0 ? v.verdictTls : level === "warn" ? v.verdictWeak : v.verdictRestricted;
  const description = open ? v.verdictOpenDescription : totals.bad !== null && totals.bad > 0 ? fill(v.verdictTlsDescription, { count: formatNumber(s, totals.bad) }) : posture?.api_whitelist_enabled ? v.verdictRestrictedDescription : v.verdictUnknownDescription;
  return <section className="grid border-b border-border bg-bg/30 lg:grid-cols-[minmax(270px,.8fr)_minmax(0,1.2fr)]" data-testid="security-hero"><div className={cn("flex items-center gap-4 border-b px-4 py-5 lg:border-b-0 lg:border-r sm:px-5", levelStyles[level].border)} data-security-level={level}><span className={cn("grid h-12 w-12 shrink-0 place-items-center rounded-xl border text-xl font-extrabold", levelStyles[level].mark)} aria-hidden="true">{level === "ok" ? "✓" : "!"}</span><div className="min-w-0"><span className="text-micro font-semibold uppercase tracking-[0.16em] text-text-faint">{v.verdictKicker}</span><h2 className="mt-1 text-h2 font-semibold text-text">{verdict}</h2><p className="mt-1 text-meta leading-relaxed text-text-muted">{description}</p><span className={cn("mt-2 block text-micro font-semibold", levelStyles[level].text)}>{level === "ok" ? v.conditionsMet : v.attentionRequired}</span></div></div><div className="grid grid-cols-2 gap-px bg-border lg:grid-cols-4"><HeroVital label={v.apiAccess} value={posture ? posture.api_whitelist_enabled ? v.whitelist : v.unfiltered : "—"} hint={posture ? posture.api_whitelist_enabled ? fill(v.allowedNetworks, { count: formatNumber(s, posture.api_whitelist_entries) }) : v.anyAddress : v.awaitingData} tone={posture && !posture.api_whitelist_enabled ? "error" : undefined} /><HeroVital label={v.apiMode} value={posture ? posture.api_read_only ? "Read-only" : "Read-write" : "—"} hint={posture ? posture.api_read_only ? v.changesDenied : v.changesAvailable : v.awaitingData} /><HeroVital label={v.tlsSignals} value={displayNumber(s, totals.bad)} hint={v.badOrProbe} tone={totals.bad !== null && totals.bad > 0 ? "warn" : undefined} /><HeroVital label="ClientHello" value={displayNumber(s, totals.observed)} hint={v.captureWindow} /></div></section>;
}

function HeroVital({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: "warn" | "error" }) {
  return <div className={cn("min-w-0 bg-surface px-4 py-4", tone === "warn" && "bg-warning/5", tone === "error" && "bg-error/5")}><span className="block text-micro text-text-faint">{label}</span><strong className={cn("mt-1 block break-words text-lg font-bold tabular-nums text-text", tone === "warn" && "text-warning-text", tone === "error" && "text-error-text")}>{value}</strong><small className="mt-1 block text-micro leading-snug text-text-muted">{hint}</small></div>;
}

function PosturePanel({ posture, whitelist }: { posture: SecurityPosture; whitelist: SecurityWhitelist | null | undefined }) {
  const s = useStrings();
  const v = s.details.pages.security.view;
  const combinedRisk = !posture.api_whitelist_enabled && !posture.api_auth_header_enabled && !posture.api_read_only;
  const entries = whitelist?.entries ?? [];
  return <div className="grid gap-4 p-4 sm:p-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(280px,.65fr)]" data-testid="security-posture-panel"><section className="rounded-xl border border-border bg-bg/25 p-4 sm:p-5"><SectionHead kicker={v.requestPath} title={v.apiProtection} meta={v.sequentialConditions} /><div className="mt-5 grid items-center gap-2 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)]"><AccessStep number="1" title={v.networkFilter} text={posture.api_whitelist_enabled ? fill(v.whitelistOn, { count: formatNumber(s, posture.api_whitelist_entries) }) : v.whitelistOff} tone={posture.api_whitelist_enabled ? "ok" : "error"} /><span className="hidden text-text-faint lg:block">→</span><AccessStep number="2" title="Auth header" text={posture.api_auth_header_enabled ? v.authRequired : v.authMissing} tone={posture.api_auth_header_enabled ? "ok" : combinedRisk ? "error" : "warn"} /><span className="hidden text-text-faint lg:block">→</span><AccessStep number="3" title={v.permissions} text={posture.api_read_only ? v.readOnlyDescription : v.readWriteDescription} tone={posture.api_read_only ? "ok" : combinedRisk ? "error" : "warn"} /></div><div className={cn("mt-4 flex gap-3 rounded-xl border px-4 py-3", combinedRisk ? "border-error/35 bg-error/5" : "border-accent/20 bg-accent/5")}><span className="font-bold text-accent">i</span><p className="text-meta leading-relaxed text-text-muted">{combinedRisk ? v.openExplanation : v.barrierExplanation}</p></div></section><section className="rounded-xl border border-border bg-bg/25 p-4 sm:p-5"><SectionHead kicker={v.extraProperties} title={v.transportObservability} /><div className="mt-4 divide-y divide-border"><PostureRow label="PROXY protocol" hint={v.clientAddressHint} value={posture.proxy_protocol_enabled ? v.enabled : v.disabled} /><PostureRow label="Core telemetry" hint={v.coreSignals} value={posture.telemetry_core_enabled ? v.enabled : v.disabled} /><PostureRow label="User telemetry" hint={v.userAggregation} value={posture.telemetry_user_enabled ? v.enabled : v.disabled} /><PostureRow label={v.logLevel} hint={v.processLogging} value={posture.log_level} warn={posture.log_level === "silent"} /><PostureRow label="ME telemetry" hint={v.meDetail} value={posture.telemetry_me_level} /></div></section><section className="flex flex-col justify-between gap-4 rounded-xl border border-border bg-bg/25 p-4 sm:flex-row sm:items-center sm:p-5 xl:col-span-2"><div><span className="text-micro font-semibold uppercase tracking-[0.16em] text-text-faint">{v.allowedNetworksTitle}</span><h3 className="mt-1 text-h2 font-semibold text-text">{v.apiWhitelist} · {formatNumber(s, whitelist?.entries_total ?? posture.api_whitelist_entries)}</h3><p className="mt-1 text-meta text-text-muted">{whitelist?.enabled ?? posture.api_whitelist_enabled ? v.realCidrs : v.whitelistDisabledDescription}</p></div><div className="flex max-w-full flex-wrap gap-2">{entries.length ? entries.map((entry) => <code key={entry} className="max-w-full break-all rounded-lg border border-success/20 bg-success/5 px-3 py-2 text-meta text-success-text">{entry}</code>) : <span className="rounded-lg border border-dashed border-border px-3 py-2 text-meta text-text-muted">{v.noRestriction}</span>}</div></section></div>;
}

function AccessStep({ number, title, text, tone }: { number: string; title: string; text: string; tone: SecurityLevel }) {
  return <div className={cn("min-h-28 rounded-xl border bg-surface p-3.5", levelStyles[tone].border, tone !== "ok" && "bg-gradient-to-b from-warning/5 to-surface")}><span className={cn("grid h-6 w-6 place-items-center rounded-full border text-micro font-bold", levelStyles[tone].border, levelStyles[tone].text)}>{number}</span><strong className="mt-3 block text-meta font-semibold text-text">{title}</strong><span className="mt-1 block text-meta leading-relaxed text-text-muted">{text}</span></div>;
}

function PostureRow({ label, hint, value, warn = false }: { label: string; hint: string; value: string; warn?: boolean }) {
  return <div className="flex items-center justify-between gap-4 py-3"><div><span className="block text-meta text-text">{label}</span><small className="mt-0.5 block text-micro text-text-faint">{hint}</small></div><strong className={cn("text-meta font-semibold text-text", warn && "text-warning-text")}>{value}</strong></div>;
}

function TlsPanel({ tls, source, onRetry }: { tls: TlsFingerprints | undefined; source: SourceState | undefined; onRetry: () => void }) {
  const s = useStrings();
  const v = s.details.pages.security.view;
  const [scope, setScope] = useState<SecurityTlsScope>("by_fingerprint");
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(5);
  const rows = useMemo(() => filterTlsRows(tls?.[scope] ?? [], scope, query), [query, scope, tls]);
  const totals = tlsTotals(tls?.by_fingerprint);
  if (!tls) {
    if (source?.status === "disabled" || source?.status === "unsupported") return <div className="p-5"><GatedNote reason={source.reason} variant={source.status === "unsupported" ? "unsupported" : "disabled"} hint={source.status === "unsupported" ? "telemt_outdated" : "runtime_edge"} /></div>;
    return <SourceNotice kind={source?.status === "error" ? "error" : "loading"} onRetry={onRetry} />;
  }
  const max = Math.max(...rows.map((row) => row.total), 1);
  const scopes: Array<[SecurityTlsScope, string]> = [["by_fingerprint", v.fingerprints], ["by_ip", "IP"], ["by_cidr", v.subnets], ["by_user", v.users]];
  return <section className="p-4 sm:p-5" data-testid="security-tls-panel"><SectionHead kicker={v.clientHelloWindow} title={v.captureState} meta={fill(v.retention, { value: duration(s, tls.retention_secs) })} /><div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border lg:grid-cols-4"><CaptureStat label={v.observations} value={displayNumber(s, totals.observed)} hint={v.fourDimensions} /><CaptureStat label={v.badOrProbe} value={displayNumber(s, totals.bad)} hint="bad_or_probe" warn={(totals.bad ?? 0) > 0} /><CaptureStat label={v.parseErrors} value={formatNumber(s, tls.parse_error_total)} hint="parse_error_total" warn={tls.parse_error_total > 0} /><CaptureStat label={v.evicted} value={formatNumber(s, tls.dropped_total)} hint={fill(v.bufferCapacity, { count: formatNumber(s, tls.capacity) })} warn={tls.dropped_total > 0} /></div><div className="mt-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between"><div className="flex gap-1 overflow-x-auto" role="tablist" aria-label={v.tlsDimensions}>{scopes.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={scope === id} onClick={() => { setScope(id); setVisible(5); }} className={cn("shrink-0 rounded-lg px-3 py-2 text-meta font-semibold", scope === id ? "bg-accent/15 text-accent" : "text-text-muted hover:bg-surface-hover")}>{label}<b className="ml-2 tabular-nums">{formatNumber(s, tls[id].length)}</b></button>)}</div><label className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2 lg:w-72"><span className="text-text-faint" aria-hidden="true">⌕</span><input value={query} onChange={(event) => { setQuery(event.target.value); setVisible(5); }} className="min-w-0 flex-1 bg-transparent text-meta text-text outline-none placeholder:text-text-faint" placeholder={v.searchPlaceholder} aria-label={v.searchLabel} /></label></div><div className="mt-5 flex flex-wrap items-end justify-between gap-2"><div><span className="text-micro font-semibold uppercase tracking-[0.16em] text-text-faint">{v.ranking}</span><h3 className="mt-1 text-h2 font-semibold text-text">{scopes.find(([id]) => id === scope)?.[1]}</h3></div><span className="text-meta text-text-muted">{v.sortedByTotal}</span></div><div className="mt-3 space-y-px overflow-hidden rounded-xl border border-border bg-border">{rows.slice(0, visible).map((row, index) => <TlsRow key={`${tlsRowIdentity(row, scope)}-${row.ja3}-${index}`} row={row} scope={scope} index={index} max={max} />)}{rows.length === 0 && <div className="bg-surface px-4 py-10 text-center text-meta text-text-muted">{v.noMatches}</div>}</div><footer className="mt-3 flex flex-wrap items-center justify-between gap-2 text-micro text-text-muted"><span>{fill(v.rowsShown, { visible: formatNumber(s, Math.min(visible, rows.length)), total: formatNumber(s, rows.length) })}</span>{visible < rows.length && <button type="button" className="rounded-lg border border-border px-3 py-2 font-semibold text-text hover:border-accent/45" onClick={() => setVisible((value) => value + 10)}>{v.showMore}</button>}</footer></section>;
}

function CaptureStat({ label, value, hint, warn = false }: { label: string; value: string; hint: string; warn?: boolean }) { return <div className={cn("bg-surface px-4 py-3", warn && "bg-warning/5")}><span className="block text-micro text-text-faint">{label}</span><strong className={cn("mt-1 block text-xl font-bold tabular-nums text-text", warn && "text-warning-text")}>{value}</strong><small className="mt-1 block text-micro text-text-muted">{hint}</small></div>; }

function TlsRow({ row, scope, index, max }: { row: TlsFingerprintRow; scope: SecurityTlsScope; index: number; max: number }) {
  const s = useStrings();
  const v = s.details.pages.security.view;
  return <div className={cn("grid gap-3 bg-surface px-3 py-3 sm:grid-cols-[2rem_minmax(0,1fr)_minmax(110px,.5fr)_5.5rem] sm:items-center", row.bad_or_probe > 0 && "bg-gradient-to-r from-warning/10 to-surface")} data-security-row={row.bad_or_probe > 0 ? "warn" : "ok"}><span className="hidden text-center text-micro tabular-nums text-text-faint sm:block">{index + 1}</span><div className="min-w-0"><strong className="block truncate text-meta font-semibold text-text" title={tlsRowIdentity(row, scope)}>{tlsRowIdentity(row, scope)}</strong><span className="mt-1 block truncate font-mono text-micro text-text-faint" title={tlsRowSecondary(row, scope)}>{tlsRowSecondary(row, scope)}</span></div><div className="h-2 overflow-hidden rounded-full bg-bg ring-1 ring-inset ring-border"><i className={cn("block h-full rounded-full bg-gradient-to-r", row.bad_or_probe > 0 ? "from-warning/60 to-warning" : "from-accent/60 to-accent")} style={{ width: `${Math.max(2, row.total / max * 100)}%` }} /></div><div className="flex items-end justify-between gap-3 sm:block sm:text-right"><strong className="text-base font-bold tabular-nums text-text">{formatNumber(s, row.total)}</strong><span className={cn("block text-micro", row.bad_or_probe > 0 ? "text-warning-text" : "text-text-faint")}>{row.bad_or_probe > 0 ? fill(v.needReview, { count: formatNumber(s, row.bad_or_probe) }) : v.noSignals}</span></div></div>;
}

function LimitsPanel({ limits }: { limits: EffectiveLimits }) {
  const s = useStrings();
  const v = s.details.pages.security.view;
  const t = limits.timeouts;
  const u = limits.upstream;
  const rows = [[v.connectAttempts, formatNumber(s, u.connect_retry_attempts), "connect_retry_attempts"], [v.backoff, `${formatNumber(s, u.connect_retry_backoff_ms)} ms`, "connect_retry_backoff_ms"], [v.totalBudget, `${formatNumber(s, u.connect_budget_ms)} ms`, "connect_budget_ms"], [v.unhealthyThreshold, formatNumber(s, u.unhealthy_fail_threshold), "unhealthy_fail_threshold"], [v.failfastHardErrors, u.connect_failfast_hard_errors ? v.enabled : v.disabled, "connect_failfast_hard_errors"]];
  const runtime = [[v.configRefresh, duration(s, limits.update_every_secs), "update_every_secs"], [v.meReinit, duration(s, limits.me_reinit_every_secs), "me_reinit_every_secs"], [v.meForceClose, duration(s, limits.me_pool_force_close_secs), "me_pool_force_close_secs"], [v.clientAck, duration(s, t.client_ack_secs), "client_ack_secs"], [v.meRetryTimeout, `${formatNumber(s, t.me_one_retry)} / ${formatNumber(s, t.me_one_timeout_ms)} ms`, "me_one_retry / me_one_timeout_ms"]];
  const policy = [[v.ipPolicyMode, limits.user_ip_policy.mode, "user_ip_policy.mode"], [v.ipPolicyLimit, formatNumber(s, limits.user_ip_policy.global_each), "user_ip_policy.global_each"], [v.ipPolicyWindow, duration(s, limits.user_ip_policy.window_secs), "user_ip_policy.window_secs"], [v.tcpPolicyLimit, formatNumber(s, limits.user_tcp_policy.global_each), "user_tcp_policy.global_each"]];
  return <section className="p-4 sm:p-5" data-testid="security-limits-panel"><SectionHead kicker={v.effectiveValues} title={v.connectionBudgets} meta={v.afterDefaults} /><div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border lg:grid-cols-4"><TimeoutStep label="Handshake" value={duration(s, t.client_handshake_secs)} hint={v.handshakeHint} /><TimeoutStep label="Telegram connect" value={duration(s, t.tg_connect_secs)} hint={v.telegramConnectHint} /><TimeoutStep label="Keepalive" value={duration(s, t.client_keepalive_secs)} hint={v.keepaliveHint} /><TimeoutStep label="First byte idle" value={duration(s, t.client_first_byte_idle_secs)} hint={v.firstByteHint} /></div><div className="mt-5 grid gap-4 xl:grid-cols-3"><LimitGroup title={v.upstreamRetries} rows={rows} /><LimitGroup title={v.runtimeBudgets} rows={runtime} /><LimitGroup title={v.userPolicies} rows={policy} /></div><div className="mt-4 flex gap-3 rounded-xl border border-accent/20 bg-accent/5 px-4 py-3"><span className="font-bold text-accent">i</span><p className="text-meta leading-relaxed text-text-muted">{v.limitsExplanation}</p></div></section>;
}

function TimeoutStep({ label, value, hint }: { label: string; value: string; hint: string }) { return <div className="min-w-0 bg-surface p-3.5"><span className="block text-micro text-text-faint">{label}</span><strong className="mt-1.5 block text-lg font-bold tabular-nums text-text">{value}</strong><small className="mt-1 block text-micro leading-relaxed text-text-muted">{hint}</small></div>; }
function LimitGroup({ title, rows }: { title: string; rows: string[][] }) { return <section className="rounded-xl border border-border bg-bg/25 p-4"><h3 className="text-meta font-semibold text-text">{title}</h3><div className="mt-3 divide-y divide-border">{rows.map(([label, value, key]) => <div key={key} className="flex items-center justify-between gap-4 py-3"><div><span className="block text-meta text-text">{label}</span><small className="block break-all font-mono text-micro text-text-faint">{key}</small></div><strong className="shrink-0 text-meta font-semibold tabular-nums text-text">{value}</strong></div>)}</div></section>; }

function SourceNotice({ kind, onRetry }: { kind: "loading" | "error" | "unavailable"; onRetry?: () => void }) {
  const v = useStrings().details.pages.security.view;
  const title = kind === "loading" ? v.loading : kind === "error" ? v.sourceError : v.unavailable;
  const body = kind === "loading" ? v.loadingText : kind === "error" ? v.sourceErrorText : v.unavailableText;
  return <div className="p-5"><div className="rounded-xl border border-dashed border-border px-5 py-10 text-center"><h2 className="text-h2 font-semibold text-text">{title}</h2><p className="mx-auto mt-2 max-w-prose text-meta text-text-muted">{body}</p>{kind === "error" && onRetry && <button type="button" onClick={onRetry} className="mt-4 rounded-lg border border-border px-3 py-2 text-meta font-semibold text-text hover:border-accent/45">{v.retry}</button>}</div></div>;
}

function TechnicalPanel({ posture, tls, limits }: { posture: SecurityPosture | null | undefined; tls: TlsFingerprints | undefined; limits: EffectiveLimits | null | undefined }) {
  const v = useStrings().details.pages.security.view;
  const [open, setOpen] = useState(false);
  const rows = [["api_read_only", posture ? String(posture.api_read_only) : "—"], ["api_auth_header_enabled", posture ? String(posture.api_auth_header_enabled) : "—"], ["proxy_protocol_enabled", posture ? String(posture.proxy_protocol_enabled) : "—"], ["TLS ranking limit", tls ? String(tls.limit) : "—"], ["TLS capacity", tls ? String(tls.capacity) : "—"], ["Telemetry", posture ? `core ${posture.telemetry_core_enabled} · user ${posture.telemetry_user_enabled} · ME ${posture.telemetry_me_level}` : "—"]];
  return <section className="border-t border-border bg-bg/30"><button type="button" className="flex w-full items-center justify-between gap-4 px-4 py-4 text-left sm:px-5" aria-expanded={open} onClick={() => setOpen((value) => !value)}><span><strong className="block text-meta font-semibold text-text">{v.technical}</strong><small className="mt-0.5 block text-micro text-text-muted">{v.technicalDescription}</small></span><span className={cn("text-text-muted transition-transform", open && "rotate-180")}>⌄</span></button>{open && <div className="grid gap-px border-t border-border bg-border sm:grid-cols-2 lg:grid-cols-3" data-testid="security-technical-grid">{rows.map(([key, value]) => <div key={key} className="min-w-0 bg-surface px-4 py-3"><span className="block break-all font-mono text-micro text-text-faint">{key}</span><strong className="mt-1 block break-words text-meta font-semibold text-text">{value}</strong></div>)}{limits && Object.keys(limits.middle_proxy).length > 0 && <div className="bg-surface px-4 py-3 sm:col-span-2 lg:col-span-3"><span className="font-mono text-micro text-text-faint">middle_proxy.*</span><div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{Object.entries(limits.middle_proxy).map(([key, value]) => <span key={key} className="break-all text-micro text-text-muted"><code>{key}</code> · <b className="text-text">{String(value)}</b></span>)}</div></div>}</div>}</section>;
}

export function SecurityPage() {
  const s = useStrings();
  const v = s.details.pages.security.view;
  const topic = useSnapshot<SecurityTopic>("security");
  const tlsQuery = useTlsFingerprintsQuery();
  const navigate = useNavigate();
  const nowMs = useNow(1_000);
  const [tab, setTab] = useState<SecurityTab>("posture");
  const tls = tlsQuery.data?.data ?? undefined;
  const payload = securityPageData(topic.data, tls);
  const inputs: Record<string, DetailSourceInput> = { security: { kind: "topic", snapshot: topic }, tls: { kind: "query", isPending: tlsQuery.isPending, isError: tlsQuery.isError, error: tlsQuery.error ?? null, data: tlsQuery.data, dataUpdatedAt: tlsQuery.dataUpdatedAt, gated: tlsQuery.data ?? null } };
  const sources = useDetailSources(securityPageDefinition.sources, inputs);
  const tabs: Array<[SecurityTab, string, string, number | null]> = [["posture", v.postureTab, v.postureTabShort, null], ["tls", v.tlsTab, v.tlsTabShort, tls ? tls.by_fingerprint.length + tls.by_ip.length + tls.by_cidr.length + tls.by_user.length : null], ["limits", v.limitsTab, v.limitsTabShort, null]];
  return <div className="mx-auto w-full max-w-[1160px]" data-testid="security-detail"><section className="overflow-hidden rounded-2xl border border-border bg-surface"><div className="px-4 py-5 sm:px-5"><DetailHeader title={s.details.pages.security.title} description={v.description} breadcrumb={v.breadcrumb} status={sources.status} freshnessMs={sources.freshnessMs} nowMs={nowMs} onBack={() => void navigate({ to: "/pulse" })} /></div><SecurityHero posture={payload?.posture} tls={tls} /><nav className="grid grid-cols-3 gap-1 border-b border-border bg-bg/40 px-3 py-2 sm:flex sm:overflow-x-auto" role="tablist" aria-label={s.details.pages.security.title}>{tabs.map(([id, label, shortLabel, count]) => <button key={id} type="button" role="tab" aria-label={label} aria-selected={tab === id} onClick={() => setTab(id)} className={cn("min-w-0 rounded-lg px-1.5 py-2 text-micro font-semibold sm:shrink-0 sm:px-3 sm:text-meta", tab === id ? "bg-accent/15 text-accent" : "text-text-muted hover:bg-surface-hover")}><span className="sm:hidden">{shortLabel}</span><span className="hidden sm:inline">{label}</span>{count !== null && <b className="ml-1 rounded-md bg-bg/60 px-1 py-0.5 text-micro tabular-nums sm:ml-2 sm:px-1.5">{formatNumber(s, count)}</b>}</button>)}</nav><div className="min-h-[360px]">{tab === "posture" && (payload?.posture ? <PosturePanel posture={payload.posture} whitelist={payload.whitelist} /> : <SourceNotice kind={topic.error ? "error" : topic.data ? "unavailable" : "loading"} />)}{tab === "tls" && <TlsPanel tls={tls} source={sources.byId["tls"]} onRetry={() => void tlsQuery.refetch()} />}{tab === "limits" && (payload?.effective_limits ? <LimitsPanel limits={payload.effective_limits} /> : <SourceNotice kind={topic.error ? "error" : topic.data ? "unavailable" : "loading"} />)}</div><TechnicalPanel posture={payload?.posture} tls={tls} limits={payload?.effective_limits} /></section></div>;
}
