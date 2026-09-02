import type { ComponentType, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useStrings, type Dict } from "../i18n";
import { countLabel, formatNumber, plural } from "../i18n/plural";
import { useDisplayMode } from "../display-mode";
import { useTheme } from "../lib/useTheme";
import { useSnapshot } from "../realtime";
import type { SecurityTopic } from "../realtime/topics";
import {
  getAutoUpdateOptions,
  getHostOptions,
  getTelemtConfigOptions,
  getTelemtInfoOptions,
  getUpdatesOptions,
  listSessionsOptions,
} from "../lib/api/generated/@tanstack/react-query.gen";
import {
  IconChevronRight,
  IconPlatform,
  IconSettings,
  IconShield,
  IconUpgrade,
  IconWrench,
  type IconProps,
} from "../ui/icons";
import {
  activeUpdateRun,
  hostCapabilityCount,
  newestAvailableRelease,
  summarizeServerConfig,
  type ServerRouteMode,
} from "./hub.helpers";

type CardTone = "blue" | "green" | "amber" | "neutral" | "violet";

export function ServerMenu() {
  const s = useStrings();
  const locale = useLocale();
  const { mode } = useDisplayMode();
  const [theme] = useTheme();
  const infoQuery = useQuery(getTelemtInfoOptions());
  const configQuery = useQuery(getTelemtConfigOptions());
  const updatesQuery = useQuery(getUpdatesOptions());
  const autoUpdateQuery = useQuery(getAutoUpdateOptions());
  const hostQuery = useQuery(getHostOptions());
  const sessionsQuery = useQuery(listSessionsOptions({ query: { limit: 1 } }));
  const security = useSnapshot<SecurityTopic>("security");

  const hub = s.server.hub;
  const targets = updatesQuery.data?.targets;
  const telemtTarget = targets?.find((target) => target.target === "telemt");
  const panelTarget = targets?.find((target) => target.target === "panel");
  const telemtRelease = newestAvailableRelease(telemtTarget);
  const panelRelease = newestAvailableRelease(panelTarget);
  const activeRun = activeUpdateRun(targets);
  const telemtUnavailable =
    infoQuery.isError || infoQuery.data?.reachable === false;
  const hasUpdates = Boolean(telemtRelease || panelRelease);
  const config = summarizeServerConfig(configQuery.data);
  const capabilityCount = hostCapabilityCount(hostQuery.data?.caps);
  const manualActions = capabilityCount.total - capabilityCount.available;
  const status = telemtUnavailable
    ? "error"
    : activeRun
      ? "active"
      : hasUpdates
        ? "warn"
        : infoQuery.isPending || updatesQuery.isPending
          ? "muted"
          : "ok";

  const statusCopy = {
    error: hub.state.unavailable,
    active: hub.state.updating,
    warn: hub.state.attention,
    muted: hub.state.loading,
    ok: hub.state.current,
  }[status];

  const overview = telemtUnavailable
    ? hub.overview.unavailable
    : activeRun
      ? hub.overview.updating
      : hasUpdates
        ? hub.overview.attention
        : hub.overview.normal;

  const telemtVersion =
    infoQuery.data?.version ?? telemtTarget?.current_version ?? "—";
  const panelVersion = panelTarget?.current_version ?? "—";
  const sessionCount = sessionsQuery.data?.total;

  return (
    <div className="server-hub">
      <header className="server-hub-head">
        <div className="server-hub-title">
          <span aria-hidden="true" className="server-hub-title-icon">
            <IconPlatform />
          </span>
          <div>
            <span>{hub.eyebrow}</span>
            <h1>{s.server.title}</h1>
          </div>
        </div>
        <span className={`server-hub-state is-${status}`}>
          <i aria-hidden="true" />
          {statusCopy}
        </span>
      </header>

      <section className="server-hub-overview" aria-labelledby="server-hub-overview-title">
        <div className="server-hub-overview-copy">
          <span className={`server-hub-glyph is-${status}`} aria-hidden="true">
            <i /><i /><i />
          </span>
          <div>
            <span>{overview.kicker}</span>
            <h2 id="server-hub-overview-title">{overview.title}</h2>
            <p>{overview.note}</p>
          </div>
        </div>
        <dl className="server-hub-facts">
          <SummaryFact
            label="Telemt"
            value={telemtUnavailable ? "—" : telemtVersion}
            detail={
              telemtUnavailable
                ? hub.apiUnavailable
                : telemtRelease
                  ? `${hub.available} ${telemtRelease.version}`
                  : hub.currentVersion
            }
            attention={Boolean(telemtRelease) || telemtUnavailable}
          />
          <SummaryFact
            label={hub.panel}
            value={panelVersion}
            detail={
              panelRelease
                ? hostQuery.data?.caps.self_update
                  ? `${hub.available} ${panelRelease.version}`
                  : hub.manualInstall
                : hub.currentVersion
            }
            attention={Boolean(panelRelease && hostQuery.data?.caps.self_update)}
          />
          <SummaryFact
            label={hub.control}
            value={capabilityCount.total ? `${capabilityCount.available} ${hub.of} ${capabilityCount.total}` : "—"}
            detail={
              capabilityCount.total
                ? manualActions
                  ? `${hub.manual}: ${manualActions}`
                  : hub.fullAccess
                : hub.noData
            }
          />
        </dl>
      </section>

      <div className="server-hub-grid">
        <HubCard
          to="/server/config"
          title={s.server.menu.config.title}
          eyebrow="Telemt"
          Icon={IconWrench}
          tone="blue"
          wide
        >
          <RouteSummary mode={config.routeMode} labels={hub.route} />
          <div className="server-hub-card-facts">
            <Fact ok={config.transport !== "unknown"}>
              {config.transport === "unknown" ? hub.noData : hub.transport[config.transport]}
            </Fact>
            <Fact ok={config.masking === true}>
              {config.masking === null
                ? hub.noData
                : config.masking
                  ? hub.maskingOn
                  : hub.maskingOff}
            </Fact>
            <Fact>
              {config.dcOverrides === null
                ? hub.noData
                : `${config.dcOverrides} ${hub.dcOverrides}`}
            </Fact>
          </div>
        </HubCard>

        <HubCard
          to="/server/updates"
          title={s.server.menu.updates.title}
          eyebrow={hub.versions}
          Icon={IconUpgrade}
          tone="green"
          state={
            activeRun
              ? { text: hub.state.updating, tone: "active" }
              : hasUpdates
                ? { text: hub.availableShort, tone: "warn" }
                : { text: hub.currentShort, tone: "ok" }
          }
          attention={hasUpdates && !activeRun}
          active={Boolean(activeRun)}
        >
          <div className="server-hub-update-main">
            <span>Telemt</span>
            <strong>
              {telemtTarget?.current_version ?? "—"}
              {telemtRelease && <><i>→</i>{telemtRelease.version}</>}
            </strong>
            <small>
              {activeRun
                ? s.server.updates.phases[activeRun.phase]
                : telemtRelease
                  ? hub.stableRelease
                  : hub.currentVersion}
            </small>
          </div>
          {activeRun && (
            <div className="server-hub-update-running">
              <span><i /></span>
              <small>{s.server.updates.phases[activeRun.phase]}</small>
            </div>
          )}
          <div className="server-hub-update-secondary">
            <span>{hub.panel}<b>{panelTarget?.current_version ?? "—"}</b></span>
            <span>{hub.autoUpdate}<b>{autoUpdateLabel(autoUpdateQuery.data, hub)}</b></span>
          </div>
        </HubCard>

        <HubCard
          to="/server/security"
          title={s.server.menu.security.title}
          eyebrow={hub.security.eyebrow}
          Icon={IconShield}
          tone="amber"
        >
          <ul className="server-hub-security">
            <SecurityRow
              label={hub.security.api}
              value={securityApiLabel(security.data, hub)}
              ok={Boolean(security.data?.posture?.api_whitelist_enabled || security.data?.posture?.api_auth_header_enabled)}
            />
            <SecurityRow
              label={hub.security.tls}
              value={
                configQuery.isPending
                  ? hub.noData
                  : config.transport === "tls"
                    ? hub.security.configured
                    : hub.security.disabled
              }
              ok={config.transport === "tls"}
            />
            <SecurityRow
              label={hub.security.allowlist}
              value={
                security.data?.whitelist
                  ? countLabel(s, security.data.whitelist.entries_total, hub.security.entries)
                  : hub.noData
              }
            />
          </ul>
        </HubCard>

        <HubCard
          to="/server/platform"
          title={s.server.menu.platform.title}
          eyebrow={hub.host}
          Icon={IconPlatform}
          tone="neutral"
        >
          <div className="server-hub-platform-main">
            <strong>{capabilityCount.total ? capabilityCount.available : "—"}{capabilityCount.total > 0 && <span>/ {capabilityCount.total}</span>}</strong>
            <p>{hub.actionsAvailable}</p>
          </div>
          <div className="server-hub-tags">
            <span>{hostQuery.data?.service_manager ?? "—"}</span>
            <span>{hostQuery.data?.log_source ?? "—"}</span>
            <span>{hostQuery.data?.privileges_mode ?? hub.noData}</span>
          </div>
        </HubCard>

        <HubCard
          to="/server/settings"
          title={s.server.menu.settings.title}
          eyebrow={hub.panel}
          Icon={IconSettings}
          tone="violet"
        >
          <div className="server-hub-settings">
            <div>
              <strong>{sessionCount === undefined ? "—" : formatNumber(s, sessionCount)}</strong>
              <span>{sessionCount === undefined ? hub.noData : plural(s, sessionCount, hub.activeSessions)}</span>
            </div>
            <dl>
              <div><dt>{hub.interface}</dt><dd>{s.displayMode[mode]}</dd></div>
              <div><dt>{s.language.label}</dt><dd>{s.language[locale]}</dd></div>
              <div><dt>{s.theme.toggle}</dt><dd>{s.theme[theme]}</dd></div>
            </dl>
          </div>
        </HubCard>
      </div>
    </div>
  );
}

function SummaryFact({ label, value, detail, attention = false }: { label: string; value: string; detail: string; attention?: boolean }) {
  return <div><dt>{label}</dt><dd>{value}</dd><small className={attention ? "is-attention" : undefined}>{detail}</small></div>;
}

function HubCard({ to, title, eyebrow, Icon, tone, state, wide = false, attention = false, active = false, children }: {
  to: "/server/config" | "/server/updates" | "/server/security" | "/server/platform" | "/server/settings";
  title: string;
  eyebrow: string;
  Icon: ComponentType<IconProps>;
  tone: CardTone;
  state?: { text: string; tone: "ok" | "warn" | "active" };
  wide?: boolean;
  attention?: boolean;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <Link to={to} className={`server-hub-card tone-${tone}${wide ? " is-wide" : ""}${attention ? " is-attention" : ""}${active ? " is-active" : ""}`}>
      <header>
        <span className="server-hub-card-icon" aria-hidden="true"><Icon /></span>
        <div><small>{eyebrow}</small><h2>{title}</h2></div>
        {state && <span className={`server-hub-card-state is-${state.tone}`}>{state.text}</span>}
        <span className="server-hub-open" aria-hidden="true"><IconChevronRight /></span>
      </header>
      {children}
    </Link>
  );
}

function RouteSummary({ mode, labels }: { mode: ServerRouteMode; labels: Dict["server"]["hub"]["route"] }) {
  if (mode === "direct") {
    return <div className="server-hub-route is-direct"><div><span>{labels.clients}</span><i /><strong>{labels.direct}</strong><i /><span>DC</span></div></div>;
  }
  return (
    <div className={`server-hub-route${mode === "unknown" ? " is-unknown" : ""}`}>
      <div><span>{labels.clients}</span><i /><strong>{mode === "unknown" ? "—" : "ME"}</strong><i /><span>DC</span></div>
      {mode === "me_fallback" && <small><b>{labels.fallback}</b><em>{labels.direct}</em></small>}
    </div>
  );
}

function Fact({ ok = false, children }: { ok?: boolean; children: ReactNode }) {
  return <span><i className={ok ? "is-ok" : undefined} />{children}</span>;
}

function SecurityRow({ label, value, ok = false }: { label: string; value: string; ok?: boolean }) {
  return <li><span>{label}</span><b>{ok && <i />}{value}</b></li>;
}

function autoUpdateLabel(data: { telemt: "off" | "check" | "apply"; panel: "off" | "check" | "apply" } | undefined, hub: Dict["server"]["hub"]) {
  if (!data) return hub.noData;
  return data.telemt === "off" && data.panel === "off" ? hub.off : hub.configured;
}

function securityApiLabel(data: SecurityTopic | null, hub: Dict["server"]["hub"]) {
  const posture = data?.posture;
  if (!posture) return hub.noData;
  if (posture.api_read_only) return hub.security.readOnly;
  if (posture.api_whitelist_enabled) return hub.security.whitelist;
  if (posture.api_auth_header_enabled) return hub.security.authHeader;
  return hub.security.open;
}
