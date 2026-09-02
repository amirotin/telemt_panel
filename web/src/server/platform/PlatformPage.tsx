import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ServerShell } from "../ServerShell";
import { errorMessage, useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { StatePill } from "../../ui/StatePill";
import { Button } from "../../ui/Button";
import { CopyField } from "../../ui/CopyField";
import { ConfirmView } from "../../ui/ConfirmView";
import { Sheet } from "../../ui/Sheet";
import { Skeleton } from "../../ui/Skeleton";
import { ErrorState } from "../../ui/ErrorState";
import { pushToast } from "../../ui/Toast";
import {
  IconActivity,
  IconChevronRight,
  IconJournal,
  IconPlatform,
  IconPower,
  IconRefresh,
  IconServer,
  IconTerminal,
  IconUpgrade,
} from "../../ui/icons";
import { apiErrorCode, apiErrorMessage } from "../../people/apiError";
import { hostCapabilityCount } from "../hub.helpers";
import { isCopyableHostCommand } from "./platform.helpers";
import {
  getHostOptions,
  restartTelemtServiceMutation,
} from "../../lib/api/generated/@tanstack/react-query.gen";
import type { HostInfo } from "../../lib/api/generated/types.gen";

type CapKey = keyof HostInfo["caps"];

interface CapabilityGroupProps {
  title: string;
  description: string;
  icon: ReactNode;
  keys: CapKey[];
  info: HostInfo;
  labels: Record<CapKey, string>;
  descriptions: Record<CapKey, string>;
  availableLabel: string;
  manualLabel: string;
  wide?: boolean;
}

function CapabilityGroup({
  title,
  description,
  icon,
  keys,
  info,
  labels,
  descriptions,
  availableLabel,
  manualLabel,
  wide,
}: CapabilityGroupProps) {
  return (
    <section className={cn("min-w-0 bg-surface", wide && "sm:col-span-2")}>
      <header className="flex min-h-[70px] items-center gap-3 bg-white/[0.015] px-4 py-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-lg text-accent">
          {icon}
        </span>
        <span className="min-w-0">
          <h3 className="text-meta font-semibold text-text">{title}</h3>
          <p className="mt-1 text-micro leading-snug text-text-faint">{description}</p>
        </span>
      </header>
      {keys.map((key) => {
        const available = info.caps[key];
        return (
          <div
            key={key}
            className="flex min-h-[62px] items-center justify-between gap-3 border-t border-border px-4 py-3"
          >
            <span className="min-w-0">
              <strong className="block text-meta font-medium text-text">{labels[key]}</strong>
              <small className="mt-1 block text-micro leading-snug text-text-muted">
                {descriptions[key]}
              </small>
            </span>
            <StatePill state={available ? "ok" : "warn"} className="shrink-0">
              {available ? availableLabel : manualLabel}
            </StatePill>
          </div>
        );
      })}
    </section>
  );
}

function TechnicalSheet({
  open,
  onClose,
  info,
}: {
  open: boolean;
  onClose: () => void;
  info: HostInfo;
}) {
  const s = useStrings();
  const copy = s.server.platform.view;
  const rows = [
    ["service_manager", info.service_manager],
    ["log_source", info.log_source],
    ["privileges_mode", info.privileges_mode],
    ["os", info.os],
    ["arch", info.arch],
    ["os_release", info.os_release ?? "—"],
  ];

  return (
    <Sheet
      open={open}
      onClose={onClose}
      eyebrow={copy.technicalEyebrow}
      title={copy.technicalTitle}
      subtitle={copy.technicalDescription}
    >
      <div className="flex flex-col gap-4">
        <dl className="overflow-hidden rounded-xl border border-border">
          {rows.map(([label, value]) => (
            <div
              key={label}
              className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-3 border-b border-border px-3 py-2.5 last:border-b-0"
            >
              <dt className="truncate font-mono text-micro text-text-faint">{label}</dt>
              <dd className="break-words text-right font-mono text-[12px] text-text">{value}</dd>
            </div>
          ))}
        </dl>
        <div>
          <h3 className="mb-2 text-micro font-semibold uppercase tracking-[0.1em] text-text-faint">
            {s.server.platform.capsTitle}
          </h3>
          <div className="overflow-hidden rounded-xl border border-border">
            {(Object.keys(info.caps) as CapKey[]).map((key) => (
              <div
                key={key}
                className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5 last:border-b-0"
              >
                <code className="text-[12px] text-text-muted">{key}</code>
                <strong className={info.caps[key] ? "text-ok" : "text-warn"}>
                  {String(info.caps[key])}
                </strong>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Sheet>
  );
}

export function PlatformPage() {
  const s = useStrings();
  const copy = s.server.platform.view;
  const query = useQuery(getHostOptions());
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const [actionOpen, setActionOpen] = useState(false);

  const restartMutation = useMutation({
    ...restartTelemtServiceMutation(),
    onSuccess: () => {
      setActionOpen(false);
      pushToast(s.server.platform.restarted, "ok");
    },
    onError: (err) => pushToast(apiErrorMessage(err, s), "error"),
  });

  if (query.isPending) {
    return (
      <ServerShell title={s.server.platform.title}>
        <Skeleton className="h-72 w-full" />
      </ServerShell>
    );
  }

  if (query.isError) {
    return (
      <ServerShell title={s.server.platform.title}>
        <ErrorState
          message={errorMessage(s, apiErrorCode(query.error) ?? "internal_error")}
          onRetry={() => query.refetch()}
        />
      </ServerShell>
    );
  }

  const info = query.data;
  const summary = hostCapabilityCount(info.caps);
  const automated = summary.available === summary.total;
  const manualEntries = Object.entries(info.manual_commands ?? {}).filter(([, value]) => value.trim());
  const restartInstruction = info.manual_commands?.["restart_telemt"];

  const managerLabels: Record<HostInfo["service_manager"], string> = {
    systemd: "systemd",
    openrc: "OpenRC",
    procd: "procd",
    sysvinit: "SysV init",
    docker: "Docker",
    none: copy.notDetected,
  };
  const logLabels: Record<HostInfo["log_source"], string> = {
    journald: "journald",
    logread: "logread",
    syslog: "syslog",
    docker: "Docker logs",
    file: copy.logFile,
    none: copy.notDetected,
  };
  const privilegeLabels: Record<HostInfo["privileges_mode"], string> = {
    sudo: "sudo",
    direct: "root",
    manual: copy.manual,
  };
  const privilegeNotes: Record<HostInfo["privileges_mode"], string> = {
    sudo: copy.sudoNote,
    direct: copy.directNote,
    manual: copy.manualNote,
  };
  const labels = s.server.platform.caps;
  const descriptions: Record<CapKey, string> = copy.capDescriptions;

  return (
    <ServerShell title={s.server.platform.title}>
      <div className="flex w-full flex-col gap-3" data-testid="server-platform-page">
        <section
          className={cn(
            "overflow-hidden rounded-2xl border bg-gradient-to-br",
            automated
              ? "border-ok/30 from-ok/[0.11] via-surface to-surface"
              : "border-warn/35 from-warn/[0.11] via-surface to-surface",
          )}
        >
          <div className="grid lg:grid-cols-[minmax(300px,0.9fr)_minmax(360px,1.1fr)]">
            <div className="flex min-h-[178px] flex-col justify-center px-5 py-6 sm:px-6">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-micro font-semibold uppercase tracking-[0.12em] text-text-faint">
                  {copy.heroEyebrow}
                </span>
                <StatePill state={automated ? "ok" : "warn"}>
                  {summary.available} / {summary.total} {copy.availableShort}
                </StatePill>
              </div>
              <h2 className="mt-4 max-w-xl text-[24px] font-bold leading-tight tracking-[-0.025em] text-text sm:text-[28px]">
                {automated ? copy.automatedTitle : copy.partialTitle}
              </h2>
              <p className="mt-3 max-w-xl text-meta leading-relaxed text-text-muted">
                {automated ? copy.automatedDescription : copy.partialDescription}
              </p>
            </div>

            <div className="relative grid min-h-[164px] grid-cols-[minmax(0,1fr)_48px_minmax(0,1fr)] items-center gap-1 border-t border-border px-2 py-5 sm:grid-cols-[minmax(0,1fr)_72px_minmax(0,1fr)] sm:gap-2 sm:px-4 lg:border-l lg:border-t-0">
              <div className="relative z-[1] flex min-w-0 items-center gap-1.5 rounded-xl border border-accent/25 bg-bg/45 p-2 shadow-lg shadow-black/10 sm:gap-2.5 sm:p-3">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent sm:h-9 sm:w-9">
                  <IconPlatform className="h-4 w-4 sm:h-5 sm:w-5" />
                </span>
                <span className="min-w-0">
                  <small className="block text-[9px] font-semibold uppercase tracking-[0.08em] text-text-faint">
                    {copy.controlSource}
                  </small>
                  <strong className="mt-1 block truncate text-[10px] text-text sm:text-meta">{copy.controlPanel}</strong>
                </span>
              </div>
              <div className="relative z-[1] grid place-items-center">
                <span className={cn("absolute h-px w-full bg-gradient-to-r from-accent", info.privileges_mode === "manual" ? "to-warn" : "to-ok")} aria-hidden="true" />
                <span className="absolute left-1 h-2 w-2 animate-pulse rounded-full bg-accent shadow-[0_0_12px_currentColor]" aria-hidden="true" />
                <span className={cn("relative rounded-full border bg-bg px-1.5 py-1 font-mono text-[8px] font-semibold sm:px-2 sm:text-[9px]", info.privileges_mode === "manual" ? "border-warn/30 text-warn" : "border-accent/25 text-accent")}>
                  {privilegeLabels[info.privileges_mode]}
                </span>
              </div>
              <div className="relative z-[1] flex min-w-0 items-center gap-1.5 rounded-xl border border-ok/25 bg-bg/45 p-2 shadow-lg shadow-black/10 sm:gap-2.5 sm:p-3">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-ok/10 text-ok sm:h-9 sm:w-9">
                  <IconServer className="h-4 w-4 sm:h-5 sm:w-5" />
                </span>
                <span className="min-w-0">
                  <small className="block text-[9px] font-semibold uppercase tracking-[0.08em] text-text-faint">
                    {copy.controlTarget}
                  </small>
                  <strong className="mt-1 block truncate text-[10px] text-text sm:text-meta">
                    {managerLabels[info.service_manager]}
                  </strong>
                  <span className="mt-1 block truncate text-[10px] text-text-faint">
                    {logLabels[info.log_source]}
                  </span>
                </span>
              </div>
            </div>
          </div>

          <dl className="grid grid-cols-3 border-t border-border bg-bg/20">
            <div className="min-w-0 px-3 py-3 sm:px-5">
              <dt className="text-[9px] font-semibold uppercase tracking-[0.1em] text-text-faint">{copy.system}</dt>
              <dd className="mt-1 font-mono text-[11px] font-semibold text-text sm:text-meta">
                <span>{info.os}</span>
                <span className="block sm:inline"> <span className="hidden sm:inline">· </span>{info.arch}</span>
              </dd>
              <small className="mt-1 hidden truncate text-micro text-text-faint sm:block">{info.os_release ?? copy.notDetected}</small>
            </div>
            <div className="min-w-0 border-l border-border px-3 py-3 sm:px-5">
              <dt className="text-[9px] font-semibold uppercase tracking-[0.1em] text-text-faint">{s.server.platform.serviceManager}</dt>
              <dd className="mt-1 truncate font-mono text-meta font-semibold text-text">{managerLabels[info.service_manager]}</dd>
              <small className="mt-1 hidden truncate text-micro text-text-faint sm:block">{copy.autoDetected}</small>
            </div>
            <div className="min-w-0 border-l border-border px-3 py-3 sm:px-5">
              <dt className="text-[9px] font-semibold uppercase tracking-[0.1em] text-text-faint">{s.server.platform.logSource}</dt>
              <dd className="mt-1 truncate font-mono text-meta font-semibold text-text">{logLabels[info.log_source]}</dd>
              <small className="mt-1 hidden truncate text-micro text-text-faint sm:block">{copy.tailAndStream}</small>
            </div>
          </dl>
        </section>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1.45fr)_minmax(290px,0.7fr)]">
          <section className="min-w-0 overflow-hidden rounded-2xl border border-border bg-surface">
            <header className="flex min-h-[68px] items-center justify-between gap-3 border-b border-border px-4 py-3">
              <span>
                <small className="block text-micro font-semibold uppercase tracking-[0.1em] text-text-faint">
                  {copy.capabilityEyebrow}
                </small>
                {/* Kept as h2: the mobile e2e contract uses this heading. */}
                <h2 className="mt-1 text-[15px] font-semibold text-text">{s.server.platform.capsTitle}</h2>
              </span>
              <span className={cn("rounded-full px-3 py-1.5 font-mono text-micro font-bold", automated ? "bg-ok/12 text-ok" : "bg-warn/12 text-warn")}>
                {summary.available} / {summary.total}
              </span>
            </header>
            <div className="grid gap-px bg-border sm:grid-cols-2">
              <CapabilityGroup
                title={copy.serviceGroup}
                description={copy.serviceGroupDescription}
                icon={<IconPower className="h-5 w-5" />}
                keys={["restart_telemt", "restart_panel"]}
                info={info}
                labels={labels}
                descriptions={descriptions}
                availableLabel={copy.available}
                manualLabel={copy.byHand}
              />
              <CapabilityGroup
                title={copy.journalGroup}
                description={copy.journalGroupDescription}
                icon={<IconJournal className="h-5 w-5" />}
                keys={["log_tail", "log_stream"]}
                info={info}
                labels={labels}
                descriptions={descriptions}
                availableLabel={copy.available}
                manualLabel={copy.byHand}
              />
              <CapabilityGroup
                title={copy.updatesGroup}
                description={copy.updatesGroupDescription}
                icon={<IconUpgrade className="h-5 w-5" />}
                keys={["self_update"]}
                info={info}
                labels={labels}
                descriptions={descriptions}
                availableLabel={copy.available}
                manualLabel={copy.byHand}
                wide
              />
            </div>
            <div className="flex flex-col items-stretch justify-between gap-3 border-t border-border px-4 py-4 sm:flex-row sm:items-center">
              <span>
                <strong className="block text-meta font-semibold text-text">
                  {info.caps.restart_telemt ? copy.restartAvailableTitle : copy.restartManualTitle}
                </strong>
                <span className="mt-1 block text-micro text-text-muted">
                  {info.caps.restart_telemt ? copy.restartAvailableNote : copy.restartManualNote}
                </span>
              </span>
              <Button
                variant={info.caps.restart_telemt ? "primary" : "secondary"}
                onClick={() => setActionOpen(true)}
                className="w-full sm:w-auto"
                data-testid="platform-restart-action"
              >
                {info.caps.restart_telemt ? <IconRefresh className="h-4 w-4" /> : <IconTerminal className="h-4 w-4" />}
                {info.caps.restart_telemt ? s.server.platform.restartTelemt : copy.showInstruction}
              </Button>
            </div>
          </section>

          <aside
            className={cn(
              "grid min-w-0 content-start gap-3 lg:grid-cols-1",
              manualEntries.length > 0 && "md:grid-cols-2",
            )}
          >
            <section className="rounded-2xl border border-border bg-surface p-4">
              <small className="block text-micro font-semibold uppercase tracking-[0.1em] text-text-faint">{copy.routeEyebrow}</small>
              <h2 className="mt-1 text-[15px] font-semibold text-text">{copy.routeTitle}</h2>
              <div
                className={cn(
                  "mt-4 grid gap-4",
                  manualEntries.length === 0 && "md:grid-cols-3 lg:grid-cols-1",
                )}
              >
                {[
                  [<IconServer className="h-4 w-4" />, `${copy.managerDetected}: ${managerLabels[info.service_manager]}`, copy.managerRouteNote],
                  [<IconActivity className="h-4 w-4" />, `${copy.accessChecked}: ${privilegeLabels[info.privileges_mode]}`, privilegeNotes[info.privileges_mode]],
                  [<IconJournal className="h-4 w-4" />, `${copy.logsConnected}: ${logLabels[info.log_source]}`, copy.logsRouteNote],
                ].map(([icon, title, note], index) => (
                  <div key={String(title)} className="relative flex gap-3">
                    {index < 2 && (
                      <span
                        className={cn(
                          "absolute left-[15px] top-8 h-[calc(100%+0.25rem)] w-px bg-border",
                          manualEntries.length === 0 && "md:hidden lg:block",
                        )}
                        aria-hidden="true"
                      />
                    )}
                    <span className="relative z-[1] grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-accent">{icon}</span>
                    <span className="min-w-0 pt-0.5">
                      <strong className="block text-meta font-medium text-text">{title}</strong>
                      <small className="mt-1 block text-micro leading-snug text-text-muted">{note}</small>
                    </span>
                  </div>
                ))}
              </div>
            </section>

            {manualEntries.length > 0 && (
              <section className="rounded-2xl border border-warn/25 bg-warn/[0.045] p-4">
                <small className="block text-micro font-semibold uppercase tracking-[0.1em] text-warn">{copy.manualEyebrow}</small>
                <h2 className="mt-1 text-[15px] font-semibold text-text">{s.server.platform.manualCommandsTitle}</h2>
                <p className="mt-2 text-micro leading-relaxed text-text-muted">{copy.manualDescription}</p>
                <div className="mt-3 space-y-3">
                  {manualEntries.map(([key, instruction]) =>
                    isCopyableHostCommand(instruction) ? (
                      <CopyField key={key} label={labels[key as CapKey] ?? key} value={instruction} />
                    ) : (
                      <div key={key}>
                        <span className="text-micro font-medium uppercase tracking-[0.06em] text-text-faint">
                          {labels[key as CapKey] ?? key}
                        </span>
                        <p className="mt-1 rounded-lg bg-surface-2 px-3 py-2.5 text-micro leading-relaxed text-text-muted">
                          {instruction}
                        </p>
                      </div>
                    ),
                  )}
                </div>
              </section>
            )}

            <button
              type="button"
              onClick={() => setTechnicalOpen(true)}
              className={cn(
                "group flex min-h-[68px] scroll-mb-20 items-center justify-between gap-4 rounded-2xl border border-border bg-surface px-4 text-left hover:border-border-strong hover:bg-surface-hover min-[600px]:scroll-mb-0 lg:col-span-1",
                manualEntries.length > 0 && "md:col-span-2",
              )}
              data-testid="platform-technical-trigger"
            >
              <span>
                <small className="block text-micro font-semibold uppercase tracking-[0.1em] text-text-faint">{copy.technicalEyebrow}</small>
                <strong className="mt-1 block text-meta font-semibold text-text">{copy.technicalTrigger}</strong>
              </span>
              <IconChevronRight className="h-4 w-4 shrink-0 text-accent transition-transform group-hover:translate-x-0.5" />
            </button>
            <span className="h-[68px] min-[600px]:hidden" aria-hidden="true" />
          </aside>
        </div>
      </div>

      <TechnicalSheet open={technicalOpen} onClose={() => setTechnicalOpen(false)} info={info} />
      <Sheet
        open={actionOpen}
        onClose={() => setActionOpen(false)}
        eyebrow={info.caps.restart_telemt ? copy.confirmEyebrow : copy.manualEyebrow}
        title={info.caps.restart_telemt ? copy.confirmTitle : s.server.platform.caps.restart_telemt}
        subtitle={info.caps.restart_telemt ? copy.confirmSubtitle : copy.manualRestartSubtitle}
      >
        {info.caps.restart_telemt ? (
          <ConfirmView
            description={s.server.platform.restartConfirm}
            confirmLabel={s.server.platform.restartTelemt}
            danger
            pending={restartMutation.isPending}
            onCancel={() => setActionOpen(false)}
            onConfirm={() => restartMutation.mutate({})}
          />
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-meta leading-relaxed text-text-muted">{copy.manualRestartDescription}</p>
            {restartInstruction && isCopyableHostCommand(restartInstruction) ? (
              <CopyField label={copy.command} value={restartInstruction} data-testid="platform-manual-restart" />
            ) : restartInstruction ? (
              <p className="rounded-xl bg-surface-2 px-4 py-3 text-meta leading-relaxed text-text-muted">
                {restartInstruction}
              </p>
            ) : (
              <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-meta text-text-muted">
                {copy.noInstruction}
              </p>
            )}
          </div>
        )}
      </Sheet>
    </ServerShell>
  );
}
