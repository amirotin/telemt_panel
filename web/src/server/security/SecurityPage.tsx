import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ServerShell } from "../ServerShell";
import { fill, formatNumber, useStrings, type Dict } from "../../i18n";
import { cn } from "../../lib/cn";
import { useSnapshot } from "../../realtime";
import type {
  EffectiveLimits,
  SecurityPosture,
  SecurityTopic,
  SecurityWhitelist,
} from "../../realtime/topics";
import { CopyField } from "../../ui/CopyField";
import { Sheet } from "../../ui/Sheet";
import { Skeleton } from "../../ui/Skeleton";
import { StatePill } from "../../ui/StatePill";
import {
  IconChevronRight,
  IconInfo,
  IconLink,
  IconShield,
  IconSwap,
  IconTarget,
} from "../../ui/icons";
import { TlsSourceNotice } from "../../pulse/widgets/TlsSourceNotice";
import { useTlsFingerprints } from "../../pulse/widgets/useTlsFingerprints";
import {
  securityLevel,
  tlsTotals,
  type SecurityLevel,
} from "../../pulse/diag/security.view.helpers";
import { apiProtectionKind, type ApiProtectionKind } from "./access.helpers";

const levelClasses: Record<SecurityLevel, { border: string; background: string; text: string }> = {
  ok: {
    border: "border-success/35",
    background: "from-success/15 via-surface to-surface",
    text: "text-success-text",
  },
  warn: {
    border: "border-warning/40",
    background: "from-warning/15 via-surface to-surface",
    text: "text-warning-text",
  },
  error: {
    border: "border-error/45",
    background: "from-error/15 via-surface to-surface",
    text: "text-error-text",
  },
};

function duration(s: Dict, seconds: number): string {
  const v = s.details.pages.security.view;
  if (seconds >= 60 && seconds % 60 === 0) {
    return fill(v.minutes, { count: formatNumber(s, seconds / 60) });
  }
  return fill(v.seconds, { count: formatNumber(s, seconds) });
}

function protectionCopy(kind: ApiProtectionKind, s: Dict) {
  const copy = s.server.security.view;
  switch (kind) {
    case "local":
      return { kicker: copy.localKicker, title: copy.localTitle, body: copy.localDescription };
    case "layered":
      return { kicker: copy.remoteKicker, title: copy.layeredTitle, body: copy.layeredDescription };
    case "whitelist":
      return { kicker: copy.restrictedKicker, title: copy.whitelistTitle, body: copy.whitelistDescription };
    case "auth":
      return { kicker: copy.restrictedKicker, title: copy.authTitle, body: copy.authDescription };
    case "read_only":
      return { kicker: copy.readOnlyKicker, title: copy.readOnlyTitle, body: copy.readOnlyDescription };
    case "exposed":
      return { kicker: copy.exposedKicker, title: copy.exposedTitle, body: copy.exposedDescription };
    default:
      return { kicker: copy.unknownKicker, title: copy.unknownTitle, body: copy.unknownDescription };
  }
}

function accessFact(kind: ApiProtectionKind, whitelist: SecurityWhitelist | null, s: Dict) {
  const copy = s.server.security.view;
  if (kind === "local") {
    return { value: copy.localhost, note: fill(copy.networks, { count: formatNumber(s, whitelist?.entries_total ?? 0) }) };
  }
  if (kind === "exposed" || kind === "read_only") {
    return { value: copy.allNetworks, note: copy.noWhitelist };
  }
  const count = whitelist?.entries_total ?? 0;
  return { value: fill(copy.networks, { count: formatNumber(s, count) }), note: copy.filteredAccess };
}

function authFact(kind: ApiProtectionKind, s: Dict) {
  const copy = s.server.security.view;
  if (kind === "layered") return { value: copy.twoLayers, note: copy.networkAndSecret };
  if (kind === "auth") return { value: copy.authHeader, note: copy.secretRequired };
  if (kind === "local" || kind === "whitelist") return { value: copy.whitelist, note: copy.withoutAuthHeader };
  return { value: copy.notConfigured, note: copy.noSecondBarrier };
}

function HeroFact({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="min-w-0 px-3 py-3 sm:px-4 lg:flex lg:flex-col lg:justify-center">
      <dt className="text-micro font-semibold uppercase tracking-[0.12em] text-text-faint">{label}</dt>
      <dd className="mt-1 truncate text-[14px] font-bold tabular-nums text-text sm:text-[16px]">{value}</dd>
      <small className="mt-0.5 block text-micro leading-snug text-text-faint">{note}</small>
    </div>
  );
}

function SecurityHero({ posture, whitelist, level, tlsObserved, tlsBad }: {
  posture: SecurityPosture | null;
  whitelist: SecurityWhitelist | null;
  level: SecurityLevel;
  tlsObserved: number | null;
  tlsBad: number | null;
}) {
  const s = useStrings();
  const copy = s.server.security.view;
  const kind = apiProtectionKind(posture, whitelist);
  const text = protectionCopy(kind, s);
  const access = accessFact(kind, whitelist, s);
  const auth = authFact(kind, s);
  const styles = levelClasses[level];
  const whitelistCount = whitelist?.entries_total ?? posture?.api_whitelist_entries ?? 0;

  return (
    <section className={cn("overflow-hidden rounded-2xl border bg-gradient-to-br", styles.border, styles.background)} data-testid="server-security-hero" data-security-level={level}>
      <div className="grid items-center md:grid-cols-[120px_minmax(0,1fr)] xl:grid-cols-[150px_minmax(0,1fr)_minmax(360px,.8fr)]">
        <div className="relative hidden h-44 place-items-center overflow-hidden md:grid">
          <span className={cn("absolute h-28 w-28 rounded-full border border-dashed opacity-45", styles.border)} />
          <span className={cn("absolute h-20 w-20 rounded-full border opacity-70", styles.border)} />
          <span className={cn("relative grid h-12 w-12 place-items-center rounded-2xl border bg-surface/75", styles.border, styles.text)}><IconShield className="h-6 w-6" /></span>
          <span className="absolute left-3 top-7 rounded-full border border-border bg-bg/80 px-2 py-1 font-mono text-[8px] font-bold text-text-faint">API</span>
          <span className="absolute bottom-6 right-2 rounded-full border border-border bg-bg/80 px-2 py-1 font-mono text-[8px] font-bold text-text-faint">HOST</span>
        </div>

        <div className="px-4 py-5 sm:px-5 md:pl-0">
          <span className={cn("text-micro font-semibold uppercase tracking-[0.16em]", styles.text)}>{text.kicker}</span>
          <h2 className="mt-1 max-w-xl text-[23px] font-bold leading-[1.08] tracking-[-0.035em] text-text sm:text-[28px]">{text.title}</h2>
          <p className="mt-2 max-w-2xl text-meta leading-relaxed text-text-muted">{text.body}</p>
          <div className="mt-4 flex flex-wrap gap-1.5">
            <span className={cn("rounded-full border px-2 py-1 text-micro font-semibold", styles.border, styles.text)}>{posture?.api_whitelist_enabled ? copy.whitelistOn : copy.whitelistOff}</span>
            <span className="rounded-full border border-border bg-bg/35 px-2 py-1 text-micro font-semibold text-text-muted">{fill(copy.networks, { count: formatNumber(s, whitelistCount) })}</span>
            <span className="rounded-full border border-border bg-bg/35 px-2 py-1 text-micro font-semibold text-text-muted">{posture?.api_read_only ? copy.readOnly : copy.writesAllowed}</span>
          </div>
        </div>

        <dl className="grid grid-cols-1 divide-y divide-border border-t border-border/80 bg-bg/15 sm:grid-cols-3 sm:divide-x sm:divide-y-0 md:col-span-2 xl:col-span-1 xl:self-stretch xl:border-l xl:border-t-0">
          <HeroFact label={copy.access} value={access.value} note={access.note} />
          <HeroFact label={copy.authorization} value={auth.value} note={auth.note} />
          <HeroFact label={copy.tlsWindow} value={tlsObserved === null ? "—" : formatNumber(s, tlsObserved)} note={tlsBad === null ? copy.awaitingTls : fill(copy.suspicious, { count: formatNumber(s, tlsBad) })} />
        </dl>
      </div>
    </section>
  );
}

function SectionHeader({ kicker, title, state }: { kicker: string; title: string; state?: ReactNode }) {
  return (
    <header className="flex min-h-[62px] items-center justify-between gap-3 border-b border-border px-4 py-3">
      <div><span className="text-micro font-semibold uppercase tracking-[0.13em] text-text-faint">{kicker}</span><h3 className="mt-0.5 text-[14px] font-semibold text-text">{title}</h3></div>
      {state}
    </header>
  );
}

function AccessCard({ posture, whitelist, kind }: { posture: SecurityPosture; whitelist: SecurityWhitelist | null; kind: ApiProtectionKind }) {
  const s = useStrings();
  const v = s.details.pages.security.view;
  const copy = s.server.security.view;
  const exposed = kind === "exposed";
  const count = whitelist?.entries_total ?? posture.api_whitelist_entries;
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-surface" data-testid="server-security-access">
      <SectionHeader kicker={copy.perimeter} title={copy.apiAccessTitle} state={<StatePill state={exposed ? "error" : "ok"}>{exposed ? copy.open : copy.restricted}</StatePill>} />
      <div className={cn("mx-4 mt-4 flex gap-3 rounded-xl px-3 py-3", exposed ? "bg-error/10" : "bg-success/10")}>
        <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-lg", exposed ? "bg-error/15 text-error-text" : "bg-success/15 text-success-text")}>{exposed ? "!" : "✓"}</span>
        <div><strong className="block text-meta font-semibold text-text">{exposed ? copy.dangerousCombination : copy.safeCombination}</strong><span className="mt-0.5 block text-micro leading-relaxed text-text-muted">{exposed ? copy.dangerousCombinationDescription : copy.safeCombinationDescription}</span></div>
      </div>
      <dl className="divide-y divide-border px-4 py-2">
        <div className="flex min-h-11 items-center justify-between gap-4"><dt className="text-meta text-text-muted">{v.whitelist}</dt><dd className="text-right text-meta font-semibold text-text">{posture.api_whitelist_enabled ? v.enabled : v.disabled}</dd></div>
        <div className="flex min-h-11 items-center justify-between gap-4"><dt className="text-meta text-text-muted">{copy.authHeader}</dt><dd className="text-right text-meta font-semibold text-text">{posture.api_auth_header_enabled ? copy.configured : copy.notConfigured}</dd></div>
        <div className="flex min-h-11 items-center justify-between gap-4"><dt className="text-meta text-text-muted">{v.apiMode}</dt><dd className="text-right text-meta font-semibold text-text">{posture.api_read_only ? v.readOnlyDescription : copy.readWrite}</dd></div>
      </dl>

      <div className="mx-4 mb-4 overflow-hidden rounded-xl border border-border bg-bg/35">
        <div className="flex items-center justify-between border-b border-border px-3 py-2"><span className="text-micro font-semibold uppercase tracking-[0.1em] text-text-faint">{v.allowedNetworksTitle}</span><span className="text-micro tabular-nums text-text-faint">{fill(copy.entries, { count: formatNumber(s, count) })}</span></div>
        {whitelist?.entries.length ? <div className="grid gap-2 p-2 sm:grid-cols-2">{whitelist.entries.map((entry) => <CopyField key={entry} value={entry} />)}</div> : <p className="px-3 py-4 text-meta text-text-muted">{s.server.security.whitelistEmpty}</p>}
      </div>
      <Link to="/server/config" className="group flex min-h-11 items-center justify-between border-t border-border px-4 text-meta font-semibold text-accent hover:bg-surface-hover">{copy.openConfig}<IconChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" /></Link>
    </section>
  );
}

function LimitsCard({ limits }: { limits: EffectiveLimits | null }) {
  const s = useStrings();
  const copy = s.server.security.view;
  if (!limits) return null;
  const ip = limits.user_ip_policy;
  const tcp = limits.user_tcp_policy.global_each;
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-surface" data-testid="server-security-limits">
      <SectionHeader kicker={copy.clients} title={copy.connectionLimits} state={<StatePill state="ok">{copy.active}</StatePill>} />
      <div className="flex items-center gap-4 px-4 py-4 sm:gap-5">
        <span className="grid h-20 w-20 shrink-0 place-items-center rounded-full border-[6px] border-accent/70 bg-accent/5 text-center"><span><strong className="block text-[25px] font-bold leading-none tabular-nums text-text">{formatNumber(s, ip.global_each)}</strong><small className="mt-1 block text-[8px] font-semibold uppercase tracking-[0.08em] text-text-faint">{copy.perIp}</small></span></span>
        <div><strong className="block text-[13px] font-semibold text-text">{fill(copy.activePerIp, { count: formatNumber(s, ip.global_each) })}</strong><span className="mt-1 block text-micro leading-relaxed text-text-muted">{fill(copy.activeWindowDescription, { seconds: formatNumber(s, ip.window_secs) })}</span></div>
      </div>
      <dl className="grid grid-cols-2 divide-x divide-border border-t border-border">
        <div className="px-4 py-3"><dt className="text-micro text-text-faint">{copy.policy}</dt><dd className="mt-1 text-meta font-semibold text-text">{ip.mode}</dd></div>
        <div className="px-4 py-3"><dt className="text-micro text-text-faint">{copy.tcpLimit}</dt><dd className="mt-1 text-meta font-semibold text-text">{tcp === 0 ? copy.unlimited : formatNumber(s, tcp)}</dd><small className="mt-0.5 block text-micro text-text-faint">{tcp === 0 ? copy.zeroMeansUnlimited : ""}</small></div>
      </dl>
    </section>
  );
}

function TlsCard({ tls }: { tls: ReturnType<typeof useTlsFingerprints> }) {
  const s = useStrings();
  const v = s.details.pages.security.view;
  const copy = s.server.security.view;
  const data = tls.status === "ok" ? tls.data : undefined;
  const totals = tlsTotals(data?.by_fingerprint);
  const bars = [...(data?.by_fingerprint ?? [])].sort((a, b) => b.total - a.total).slice(0, 12);
  const max = Math.max(...bars.map((row) => row.total), 1);
  const level = (totals.bad ?? 0) > 0 || (data?.parse_error_total ?? 0) > 0 ? "warn" : "ok";
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-surface" data-testid="server-security-tls">
      <SectionHeader kicker={data ? fill(copy.lastWindow, { value: duration(s, data.retention_secs) }) : copy.tlsWindow} title={copy.tlsActivity} state={data ? <StatePill state={level}>{level === "ok" ? copy.calm : copy.review}</StatePill> : undefined} />
      {data ? <>
        <div className="flex items-end gap-2 px-4 pt-4"><strong className={cn("text-[38px] font-bold leading-none tabular-nums", level === "ok" ? "text-text" : "text-warning-text")}>{formatNumber(s, totals.bad ?? 0)}</strong><span className="pb-0.5 text-micro leading-snug text-text-muted">{copy.suspiciousHandshakes}</span></div>
        <div className="flex h-[76px] items-end gap-1 px-4 py-3" role="img" aria-label={copy.fingerprintDistribution}>{bars.map((row, index) => <span key={`${row.ja4}-${index}`} className={cn("min-h-1 flex-1 rounded-t-sm bg-gradient-to-t", row.bad_or_probe > 0 ? "from-warning/25 to-warning/80" : "from-accent/20 to-accent/75")} style={{ height: `${Math.max(8, row.total / max * 100)}%` }} />)}</div>
        <dl className="grid grid-cols-2 divide-x divide-border border-t border-border"><div className="px-4 py-2.5"><dt className="text-micro text-text-faint">{v.evicted}</dt><dd className="mt-0.5 text-meta font-semibold tabular-nums text-text">{formatNumber(s, data.dropped_total)}</dd></div><div className="px-4 py-2.5"><dt className="text-micro text-text-faint">{v.parseErrors}</dt><dd className="mt-0.5 text-meta font-semibold tabular-nums text-text">{formatNumber(s, data.parse_error_total)}</dd></div></dl>
      </> : tls.status === "loading" ? <div className="p-4"><Skeleton className="h-28 w-full" /></div> : <div className="p-4"><TlsSourceNotice state={tls} as="note" /></div>}
      <Link to="/pulse/diag/$domain" params={{ domain: "security" }} className="group flex min-h-11 items-center justify-between border-t border-border px-4 text-meta font-semibold text-accent hover:bg-surface-hover">{copy.openDiagnostics}<IconChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" /></Link>
    </section>
  );
}

function ProtocolCard({ posture }: { posture: SecurityPosture }) {
  const s = useStrings();
  const v = s.details.pages.security.view;
  const copy = s.server.security.view;
  const items = [
    [IconSwap, s.server.security.postureFields.proxyProtocolEnabled, posture.proxy_protocol_enabled ? v.enabled : v.disabled],
    [IconTarget, s.server.security.postureFields.telemetryCoreEnabled, posture.telemetry_core_enabled ? v.enabled : v.disabled],
    [IconLink, s.server.security.postureFields.telemetryUserEnabled, posture.telemetry_user_enabled ? v.enabled : v.disabled],
    [IconInfo, s.server.security.telemetryMeLevel, posture.telemetry_me_level],
  ] as const;
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-surface">
      <SectionHeader kicker={copy.context} title={v.transportObservability} />
      <div className="grid grid-cols-2 gap-1 p-3">{items.map(([Icon, label, value]) => <div key={label} className="flex min-w-0 items-center gap-2 rounded-xl px-2 py-2"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent"><Icon className="h-4 w-4" /></span><span className="min-w-0"><strong className="block truncate text-micro font-semibold text-text">{label}</strong><small className="mt-0.5 block truncate text-micro text-text-faint">{value}</small></span></div>)}</div>
      <p className="border-t border-border px-4 py-3 text-micro leading-relaxed text-text-faint">{copy.contextDescription}</p>
    </section>
  );
}

function SheetGroup({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return <section className="overflow-hidden rounded-xl border border-border"><h3 className="border-b border-border px-3 py-2 text-micro font-semibold uppercase tracking-[0.1em] text-text-muted">{title}</h3><dl className="divide-y divide-border">{rows.map(([label, value]) => <div key={label} className="flex min-h-10 items-center justify-between gap-4 px-3 py-2"><dt className="text-meta text-text-muted">{label}</dt><dd className="m-0 text-right text-meta font-semibold tabular-nums text-text">{value}</dd></div>)}</dl></section>;
}

function TechnicalSheet({ open, onClose, limits }: { open: boolean; onClose: () => void; limits: EffectiveLimits | null }) {
  const s = useStrings();
  const v = s.details.pages.security.view;
  const copy = s.server.security.view;
  const middle = limits?.middle_proxy ?? {};
  return (
    <Sheet open={open} onClose={onClose} eyebrow={copy.effectiveConfig} title={copy.timeoutsAndLimits} subtitle={copy.sheetDescription}>
      <div className="flex flex-col gap-3">{limits ? <>
        <SheetGroup title={copy.client} rows={[[v.firstByteHint, duration(s, limits.timeouts.client_first_byte_idle_secs)], [v.handshakeHint, duration(s, limits.timeouts.client_handshake_secs)], [v.keepaliveHint, duration(s, limits.timeouts.client_keepalive_secs)], [v.clientAck, duration(s, limits.timeouts.client_ack_secs)]]} />
        <SheetGroup title={v.upstreamRetries} rows={[[v.connectAttempts, formatNumber(s, limits.upstream.connect_retry_attempts)], [v.totalBudget, `${formatNumber(s, limits.upstream.connect_budget_ms)} ms`], [v.unhealthyThreshold, formatNumber(s, limits.upstream.unhealthy_fail_threshold)], [v.failfastHardErrors, limits.upstream.connect_failfast_hard_errors ? v.enabled : v.disabled]]} />
        <SheetGroup title={v.runtimeBudgets} rows={[[copy.floorMode, String(middle["floor_mode"] ?? "—")], [copy.reconnectPerDc, String(middle["reconnect_max_concurrent_per_dc"] ?? "—")], [copy.writerPick, `${String(middle["writer_pick_mode"] ?? "—")} · ${String(middle["writer_pick_sample_size"] ?? "—")}`], [copy.directFallback, middle["me2dc_fallback"] === true ? v.enabled : middle["me2dc_fallback"] === false ? v.disabled : "—"]]} />
        <Link to="/server/config" onClick={onClose} className="mt-1 rounded-xl bg-accent/15 px-4 py-3 text-center text-meta font-semibold text-accent hover:bg-accent/20">{copy.openAdvancedConfig}</Link>
      </> : <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-meta text-text-muted">{copy.limitsUnavailable}</p>}</div>
    </Sheet>
  );
}

export function SecurityPage() {
  const s = useStrings();
  const topic = useSnapshot<SecurityTopic>("security");
  const tls = useTlsFingerprints(true);
  const [technicalOpen, setTechnicalOpen] = useState(false);
  if (!topic.data) return <ServerShell title={s.server.security.title}><Skeleton className="h-72 w-full" /></ServerShell>;

  const posture = topic.data.posture;
  const whitelist = topic.data.whitelist;
  const tlsData = tls.status === "ok" ? tls.data : undefined;
  const totals = tlsTotals(tlsData?.by_fingerprint);
  const level = securityLevel(posture, totals.bad);
  const kind = apiProtectionKind(posture, whitelist);

  return (
    <ServerShell title={s.server.security.title}>
      <div className="flex w-full flex-col gap-3" data-testid="server-security-page">
        {topic.stale && <div><StatePill state="warn">{s.common.stale}</StatePill></div>}
        <SecurityHero posture={posture} whitelist={whitelist} level={level} tlsObserved={totals.observed} tlsBad={totals.bad} />
        {posture ? <div className="grid gap-3 xl:grid-cols-[minmax(0,1.5fr)_minmax(330px,.75fr)]">
          <div className="flex min-w-0 flex-col gap-3"><AccessCard posture={posture} whitelist={whitelist} kind={kind} /><LimitsCard limits={topic.data.effective_limits} /></div>
          <aside className="grid min-w-0 content-start gap-3 md:grid-cols-2 xl:grid-cols-1"><TlsCard tls={tls} /><ProtocolCard posture={posture} /><button type="button" onClick={() => setTechnicalOpen(true)} className="group flex min-h-[64px] items-center justify-between gap-4 rounded-2xl border border-border bg-surface px-4 text-left hover:border-border-strong hover:bg-surface-hover md:col-span-2 xl:col-span-1" data-testid="server-security-technical-trigger"><span><small className="block text-micro font-semibold uppercase tracking-[0.1em] text-text-faint">{s.server.security.view.effectiveConfig}</small><strong className="mt-1 block text-meta font-semibold text-text">{s.server.security.view.timeoutsAndLimits}</strong></span><IconChevronRight className="h-4 w-4 text-accent transition-transform group-hover:translate-x-0.5" /></button></aside>
        </div> : <div className="rounded-2xl border border-dashed border-border px-5 py-10 text-center text-meta text-text-muted">{s.server.security.view.postureUnavailable}</div>}
      </div>
      <TechnicalSheet open={technicalOpen} onClose={() => setTechnicalOpen(false)} limits={topic.data.effective_limits} />
    </ServerShell>
  );
}
