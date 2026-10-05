import { useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Button } from "../../ui/Button";
import { fill, formatNumber, useStrings, type Dict } from "../../i18n";
import type { TlsFingerprints } from "../../lib/api/generated/types.gen";
import { cn } from "../../lib/cn";
import { useNow } from "../../people/useNow";
import { useSnapshot } from "../../realtime";
import type { EffectiveLimits, SecurityPosture, SecurityTopic, SecurityWhitelist } from "../../realtime/topics";
import { useDetailSources, type DetailSourceInput } from "../sourceState";
import { useTlsFingerprintsQuery } from "../widgets/useTlsFingerprints";
import { DetailHeader } from "./DetailHeader";
import { securityPageData } from "./security.helpers";
import { securitySources } from "./sourceDefinitions";
import { securityLevel, tlsTotals, type SecurityLevel } from "./security.view.helpers";
import { SectionHeading } from "./SectionHeading";
import { SecuritySourceNotice as SourceNotice } from "./SecuritySourceNotice";
import { TlsPanel } from "./SecurityTlsSection";
import { LimitsPanel } from "./SecurityLimitsSection";

type SecurityTab = "posture" | "tls" | "limits";

const levelStyles: Record<SecurityLevel, { border: string; mark: string; text: string }> = {
  ok: {
    border: "border-ok/35",
    mark: "border-ok/35 bg-gradient-to-br from-ok/30 to-ok/10 text-ok",
    text: "text-ok",
  },
  warn: {
    border: "border-warn/40",
    mark: "border-warn/45 bg-gradient-to-br from-warn/30 to-warn/10 text-warn",
    text: "text-warn",
  },
  error: {
    border: "border-error/45",
    mark: "border-error/45 bg-gradient-to-br from-error/30 to-error/10 text-error-text",
    text: "text-error-text",
  },
};

function displayNumber(s: Dict, value: number | null): string {
  return value === null ? "—" : formatNumber(s, value);
}

function SecurityHero({
  posture,
  tls,
  onReview,
}: {
  posture: SecurityPosture | null | undefined;
  tls: TlsFingerprints | undefined;
  onReview: () => void;
}) {
  const s = useStrings();
  const v = s.details.pages.security.view;
  const totals = tlsTotals(tls?.by_fingerprint);
  const level = posture ? securityLevel(posture, totals.bad) : "warn";
  const open =
    posture !== null &&
    posture !== undefined &&
    !posture.api_whitelist_enabled &&
    !posture.api_auth_header_enabled &&
    !posture.api_read_only;
  const verdict = !posture
    ? v.verdictUnknown
    : open
      ? v.verdictOpen
      : totals.bad !== null && totals.bad > 0
        ? v.verdictTls
        : level === "warn"
          ? v.verdictWeak
          : v.verdictRestricted;
  const description = open
    ? v.verdictOpenDescription
    : totals.bad !== null && totals.bad > 0
      ? fill(v.verdictTlsDescription, { count: formatNumber(s, totals.bad) })
      : posture?.api_whitelist_enabled
        ? v.verdictRestrictedDescription
        : v.verdictUnknownDescription;
  return (
    <section
      className="grid border-b border-border bg-bg/30 lg:grid-cols-[minmax(270px,.8fr)_minmax(0,1.2fr)]"
      data-testid="security-hero"
    >
      <div
        className={cn(
          "flex items-center gap-4 border-b px-4 py-5 lg:border-b-0 lg:border-r sm:px-5",
          levelStyles[level].border,
        )}
        data-security-level={level}
      >
        <span
          className={cn(
            "grid h-12 w-12 shrink-0 place-items-center rounded-xl border text-xl font-extrabold",
            levelStyles[level].mark,
          )}
          aria-hidden="true"
        >
          {level === "ok" ? "✓" : "!"}
        </span>
        <div className="min-w-0">
          <span className="text-micro font-semibold uppercase tracking-[0.16em] text-text-faint">
            {v.verdictKicker}
          </span>
          <h2 className="mt-1 text-h2 font-semibold text-text">{verdict}</h2>
          <p className="mt-1 text-meta leading-relaxed text-text-muted">{description}</p>
          <span className={cn("mt-2 block text-micro font-semibold", levelStyles[level].text)}>
            {level === "ok" ? v.conditionsMet : v.attentionRequired}
          </span>
          {(totals.bad ?? 0) > 0 && (
            <Button variant="secondary" className="mt-3" onClick={onReview} aria-label={v.reviewTls}>
              {s.pulse.diagLink}
            </Button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-px bg-border lg:grid-cols-4">
        <HeroVital
          label={v.apiAccess}
          value={posture ? (posture.api_whitelist_enabled ? v.whitelist : v.unfiltered) : "—"}
          hint={
            posture
              ? posture.api_whitelist_enabled
                ? fill(v.allowedNetworks, { count: formatNumber(s, posture.api_whitelist_entries) })
                : v.anyAddress
              : v.awaitingData
          }
          tone={posture && !posture.api_whitelist_enabled ? "error" : undefined}
        />
        <HeroVital
          label={v.apiMode}
          value={posture ? (posture.api_read_only ? "Read-only" : "Read-write") : "—"}
          hint={
            posture
              ? posture.api_read_only
                ? v.changesDenied
                : v.changesAvailable
              : v.awaitingData
          }
        />
        <HeroVital
          label={v.tlsSignals}
          value={displayNumber(s, totals.bad)}
          hint={v.badOrProbe}
          tone={totals.bad !== null && totals.bad > 0 ? "warn" : undefined}
        />
        <HeroVital
          label="ClientHello"
          value={displayNumber(s, totals.observed)}
          hint={v.captureWindow}
        />
      </div>
    </section>
  );
}

function HeroVital({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "warn" | "error";
}) {
  return (
    <div
      className={cn(
        "min-w-0 bg-surface px-4 py-4",
        tone === "warn" && "bg-warn/5",
        tone === "error" && "bg-error/5",
      )}
    >
      <span className="block text-micro text-text-faint">{label}</span>
      <strong
        className={cn(
          "mt-1 block break-words text-lg font-bold tabular-nums text-text",
          tone === "warn" && "text-warn",
          tone === "error" && "text-error-text",
        )}
      >
        {value}
      </strong>
      <small className="mt-1 block text-micro leading-snug text-text-muted">{hint}</small>
    </div>
  );
}

function PosturePanel({
  posture,
  whitelist,
}: {
  posture: SecurityPosture;
  whitelist: SecurityWhitelist | null | undefined;
}) {
  const s = useStrings();
  const v = s.details.pages.security.view;
  const combinedRisk =
    !posture.api_whitelist_enabled && !posture.api_auth_header_enabled && !posture.api_read_only;
  const entries = whitelist?.entries ?? [];
  return (
    <div
      className="grid gap-4 p-4 sm:p-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(280px,.65fr)]"
      data-testid="security-posture-panel"
    >
      <section className="rounded-xl border border-border bg-bg/25 p-4 sm:p-5">
        <SectionHeading level={2} variant="standard" kicker={v.requestPath} title={v.apiProtection} meta={v.sequentialConditions} />
        <div className="mt-5 grid items-center gap-2 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
          <AccessStep
            number="1"
            title={v.networkFilter}
            text={
              posture.api_whitelist_enabled
                ? fill(v.whitelistOn, { count: formatNumber(s, posture.api_whitelist_entries) })
                : v.whitelistOff
            }
            tone={posture.api_whitelist_enabled ? "ok" : "error"}
          />
          <span className="hidden text-text-faint lg:block">→</span>
          <AccessStep
            number="2"
            title="Auth header"
            text={posture.api_auth_header_enabled ? v.authRequired : v.authMissing}
            tone={posture.api_auth_header_enabled ? "ok" : combinedRisk ? "error" : "warn"}
          />
          <span className="hidden text-text-faint lg:block">→</span>
          <AccessStep
            number="3"
            title={v.permissions}
            text={posture.api_read_only ? v.readOnlyDescription : v.readWriteDescription}
            tone={posture.api_read_only ? "ok" : combinedRisk ? "error" : "warn"}
          />
        </div>
        <div
          className={cn(
            "mt-4 flex gap-3 rounded-xl border px-4 py-3",
            combinedRisk ? "border-error/35 bg-error/5" : "border-accent/20 bg-accent/5",
          )}
        >
          <span className="font-bold text-accent">i</span>
          <p className="text-meta leading-relaxed text-text-muted">
            {combinedRisk ? v.openExplanation : v.barrierExplanation}
          </p>
        </div>
      </section>
      <section className="rounded-xl border border-border bg-bg/25 p-4 sm:p-5">
        <SectionHeading level={2} variant="standard" kicker={v.extraProperties} title={v.transportObservability} />
        <div className="mt-4 divide-y divide-border">
          <PostureRow
            label="PROXY protocol"
            hint={v.clientAddressHint}
            value={posture.proxy_protocol_enabled ? v.enabled : v.disabled}
          />
          <PostureRow
            label="Core telemetry"
            hint={v.coreSignals}
            value={posture.telemetry_core_enabled ? v.enabled : v.disabled}
          />
          <PostureRow
            label="User telemetry"
            hint={v.userAggregation}
            value={posture.telemetry_user_enabled ? v.enabled : v.disabled}
          />
          <PostureRow
            label={v.logLevel}
            hint={v.processLogging}
            value={posture.log_level}
            warn={posture.log_level === "silent"}
          />
          <PostureRow label="ME telemetry" hint={v.meDetail} value={posture.telemetry_me_level} />
        </div>
      </section>
      <section className="flex flex-col justify-between gap-4 rounded-xl border border-border bg-bg/25 p-4 sm:flex-row sm:items-center sm:p-5 xl:col-span-2">
        <div>
          <span className="text-micro font-semibold uppercase tracking-[0.16em] text-text-faint">
            {v.allowedNetworksTitle}
          </span>
          <h3 className="mt-1 text-h2 font-semibold text-text">
            {v.apiWhitelist} ·{" "}
            {formatNumber(s, whitelist?.entries_total ?? posture.api_whitelist_entries)}
          </h3>
          <p className="mt-1 text-meta text-text-muted">
            {(whitelist?.enabled ?? posture.api_whitelist_enabled)
              ? v.realCidrs
              : v.whitelistDisabledDescription}
          </p>
        </div>
        <div className="flex max-w-full flex-wrap gap-2">
          {entries.length ? (
            entries.map((entry) => (
              <code
                key={entry}
                className="max-w-full break-all rounded-lg border border-ok/20 bg-ok/5 px-3 py-2 text-meta text-ok"
              >
                {entry}
              </code>
            ))
          ) : (
            <span className="rounded-lg border border-dashed border-border px-3 py-2 text-meta text-text-muted">
              {v.noRestriction}
            </span>
          )}
        </div>
      </section>
    </div>
  );
}

function AccessStep({
  number,
  title,
  text,
  tone,
}: {
  number: string;
  title: string;
  text: string;
  tone: SecurityLevel;
}) {
  return (
    <div
      className={cn(
        "min-h-28 rounded-xl border bg-surface p-3.5",
        levelStyles[tone].border,
        tone !== "ok" && "bg-gradient-to-b from-warn/5 to-surface",
      )}
    >
      <span
        className={cn(
          "grid h-6 w-6 place-items-center rounded-full border text-micro font-bold",
          levelStyles[tone].border,
          levelStyles[tone].text,
        )}
      >
        {number}
      </span>
      <strong className="mt-3 block text-meta font-semibold text-text">{title}</strong>
      <span className="mt-1 block text-meta leading-relaxed text-text-muted">{text}</span>
    </div>
  );
}

function PostureRow({
  label,
  hint,
  value,
  warn = false,
}: {
  label: string;
  hint: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div>
        <span className="block text-meta text-text">{label}</span>
        <small className="mt-0.5 block text-micro text-text-faint">{hint}</small>
      </div>
      <strong className={cn("text-meta font-semibold text-text", warn && "text-warn")}>
        {value}
      </strong>
    </div>
  );
}

function TechnicalPanel({
  posture,
  tls,
  limits,
}: {
  posture: SecurityPosture | null | undefined;
  tls: TlsFingerprints | undefined;
  limits: EffectiveLimits | null | undefined;
}) {
  const v = useStrings().details.pages.security.view;
  const [open, setOpen] = useState(false);
  const rows = [
    ["api_read_only", posture ? String(posture.api_read_only) : "—"],
    ["api_auth_header_enabled", posture ? String(posture.api_auth_header_enabled) : "—"],
    ["proxy_protocol_enabled", posture ? String(posture.proxy_protocol_enabled) : "—"],
    [v.tlsRankingLimit, tls ? String(tls.limit) : "—"],
    [v.tlsCapacity, tls ? String(tls.capacity) : "—"],
    [
      v.telemetryLabel,
      posture
        ? `core ${posture.telemetry_core_enabled} · user ${posture.telemetry_user_enabled} · ME ${posture.telemetry_me_level}`
        : "—",
    ],
  ];
  return (
    <section className="border-t border-border bg-bg/30">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-4 px-4 py-4 text-left sm:px-5"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>
          <strong className="block text-meta font-semibold text-text">{v.technical}</strong>
          <small className="mt-0.5 block text-micro text-text-muted">
            {v.technicalDescription}
          </small>
        </span>
        <span className={cn("text-text-muted transition-transform", open && "rotate-180")}>⌄</span>
      </button>
      {open && (
        <div
          className="grid gap-px border-t border-border bg-border sm:grid-cols-2 lg:grid-cols-3"
          data-testid="security-technical-grid"
        >
          {rows.map(([key, value]) => (
            <div key={key} className="min-w-0 bg-surface px-4 py-3">
              <span className="block break-all font-mono text-micro text-text-faint">{key}</span>
              <strong className="mt-1 block break-words text-meta font-semibold text-text">
                {value}
              </strong>
            </div>
          ))}
          {limits && Object.keys(limits.middle_proxy).length > 0 && (
            <div className="bg-surface px-4 py-3 sm:col-span-2 lg:col-span-3">
              <span className="font-mono text-micro text-text-faint">middle_proxy.*</span>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {Object.entries(limits.middle_proxy).map(([key, value]) => (
                  <span key={key} className="break-all text-micro text-text-muted">
                    <code>{key}</code> · <b className="text-text">{String(value)}</b>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function SecurityPage() {
  const s = useStrings();
  const v = s.details.pages.security.view;
  const topic = useSnapshot<SecurityTopic>("security");
  const tlsQuery = useTlsFingerprintsQuery();
  const navigate = useNavigate();
  const nowMs = useNow(1_000);
  const search = useSearch({ from: "/_authed/pulse/diag/$domain" });
  const tab: SecurityTab = search.tab === "tls" || search.tab === "limits" ? search.tab : "posture";
  const scope = search.tlsScope ?? "by_fingerprint";
  const suspiciousOnly = search.tlsFilter === "suspicious";
  const detailsRef = useRef<HTMLHeadingElement>(null);
  const [reviewKey, setReviewKey] = useState(0);
  function reviewTls() {
    setReviewKey((value) => value + 1);
    void navigate({
      to: "/pulse/diag/$domain", params: { domain: "security" },
      search: { tab: "tls", tlsScope: "by_ip", tlsFilter: "suspicious" }, resetScroll: false,
    }).then(() => {
      detailsRef.current?.focus({ preventScroll: true });
      detailsRef.current?.scrollIntoView({ block: "start" });
    });
  }
  const tls = tlsQuery.data?.data ?? undefined;
  const payload = securityPageData(topic.data, tls);
  const inputs: Record<string, DetailSourceInput> = {
    security: { kind: "topic", snapshot: topic },
    tls: {
      kind: "query",
      isPending: tlsQuery.isPending,
      isError: tlsQuery.isError,
      error: tlsQuery.error ?? null,
      data: tlsQuery.data,
      dataUpdatedAt: tlsQuery.dataUpdatedAt,
      gated: tlsQuery.data ?? null,
    },
  };
  const sources = useDetailSources(securitySources, inputs);
  const tabs: Array<[SecurityTab, string, string, number | null]> = [
    ["posture", v.postureTab, v.postureTabShort, null],
    [
      "tls",
      v.tlsTab,
      v.tlsTabShort,
      tls
        ? tls.by_fingerprint.length + tls.by_ip.length + tls.by_cidr.length + tls.by_user.length
        : null,
    ],
    ["limits", v.limitsTab, v.limitsTabShort, null],
  ];
  return (
    <div className="w-full" data-testid="security-detail">
      <DetailHeader
        title={s.details.pages.security.title}
        description={v.description}
        status={sources.status}
        freshnessMs={sources.freshnessMs}
        nowMs={nowMs}
        onBack={() => void navigate({ to: "/pulse" })}
      />
      <section className="overflow-hidden rounded-2xl border border-border bg-surface">
        <SecurityHero posture={payload?.posture} tls={tls} onReview={reviewTls} />
        <nav
          className="grid grid-cols-3 gap-1 border-b border-border bg-bg/40 px-3 py-2 sm:flex sm:overflow-x-auto"
          role="tablist"
          aria-label={s.details.pages.security.title}
        >
          {tabs.map(([id, label, shortLabel, count]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-label={label}
              aria-selected={tab === id}
              onClick={() => void navigate({ to: "/pulse/diag/$domain", params: { domain: "security" }, search: (prev) => ({ ...prev, tab: id }), resetScroll: false })}
              className={cn(
                "min-w-0 rounded-lg px-1.5 py-2 text-micro font-semibold sm:shrink-0 sm:px-3 sm:text-meta",
                tab === id ? "bg-accent/15 text-accent" : "text-text-muted hover:bg-surface-hover",
              )}
            >
              <span className="sm:hidden">{shortLabel}</span>
              <span className="hidden sm:inline">{label}</span>
              {count !== null && (
                <b className="ml-1 rounded-md bg-bg/60 px-1 py-0.5 text-micro tabular-nums sm:ml-2 sm:px-1.5">
                  {formatNumber(s, count)}
                </b>
              )}
            </button>
          ))}
        </nav>
        <div className="min-h-[360px]">
          {tab === "posture" &&
            (payload?.posture ? (
              <PosturePanel posture={payload.posture} whitelist={payload.whitelist} />
            ) : (
              <SourceNotice kind={topic.error ? "error" : topic.data ? "unavailable" : "loading"} />
            ))}
          {tab === "tls" && (
            <TlsPanel
              key={reviewKey}
              tls={tls}
              source={sources.byId["tls"]}
              onRetry={() => void tlsQuery.refetch()}
              scope={scope}
              suspiciousOnly={suspiciousOnly}
              resultsRef={detailsRef}
              onScopeChange={(tlsScope) => void navigate({ to: "/pulse/diag/$domain", params: { domain: "security" }, search: (prev) => ({ ...prev, tlsScope }), resetScroll: false })}
              onFilterChange={(value) => void navigate({ to: "/pulse/diag/$domain", params: { domain: "security" }, search: (prev) => ({ ...prev, tlsFilter: value ? "suspicious" : undefined }), resetScroll: false })}
            />
          )}
          {tab === "limits" &&
            (payload?.effective_limits ? (
              <LimitsPanel limits={payload.effective_limits} />
            ) : (
              <SourceNotice kind={topic.error ? "error" : topic.data ? "unavailable" : "loading"} />
            ))}
        </div>
        <TechnicalPanel posture={payload?.posture} tls={tls} limits={payload?.effective_limits} />
      </section>
    </div>
  );
}
