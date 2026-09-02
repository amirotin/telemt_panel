import type {
  HostInfo,
  TelemtConfig,
  UpdatesStatus,
} from "../lib/api/generated/types.gen";

type UpdateTarget = UpdatesStatus["targets"][number];

export type ServerRouteMode = "me_fallback" | "me" | "direct" | "unknown";
export type ServerTransportMode = "tls" | "secure" | "classic" | "unknown";

export interface ServerConfigSummary {
  routeMode: ServerRouteMode;
  transport: ServerTransportMode;
  masking: boolean | null;
  dcOverrides: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function summarizeServerConfig(
  config: TelemtConfig | undefined,
): ServerConfigSummary {
  if (!config) {
    return {
      routeMode: "unknown",
      transport: "unknown",
      masking: null,
      dcOverrides: null,
    };
  }

  const general = asRecord(config.sections["general"]);
  const censorship = asRecord(config.sections["censorship"]);
  const modes = asRecord(general?.["modes"]);
  const overrides = asRecord(config.sections["dc_overrides"]);
  const useMiddleProxy = general?.["use_middle_proxy"];
  const fallback = general?.["me2dc_fallback"];

  let routeMode: ServerRouteMode = "unknown";
  if (useMiddleProxy === false) routeMode = "direct";
  if (useMiddleProxy === true) {
    routeMode = fallback === true ? "me_fallback" : "me";
  }

  let transport: ServerTransportMode = "unknown";
  if (modes?.["tls"] === true) transport = "tls";
  else if (modes?.["secure"] === true) transport = "secure";
  else if (modes?.["classic"] === true) transport = "classic";

  return {
    routeMode,
    transport,
    masking:
      typeof censorship?.["mask"] === "boolean" ? censorship["mask"] : null,
    dcOverrides: overrides ? Object.keys(overrides).length : null,
  };
}

export function newestAvailableRelease(target: UpdateTarget | undefined) {
  return target?.releases
    .filter((release) => release.newer)
    .toSorted((a, b) => b.published_at.localeCompare(a.published_at))[0];
}

export function activeUpdateRun(targets: UpdatesStatus["targets"] | undefined) {
  return targets?.find((target) => {
    const phase = target.active_run?.phase;
    return phase && !["done", "rolled_back", "failed"].includes(phase);
  })?.active_run;
}

export function hostCapabilityCount(caps: HostInfo["caps"] | undefined) {
  const values = caps ? Object.values(caps) : [];
  return { available: values.filter(Boolean).length, total: values.length };
}
