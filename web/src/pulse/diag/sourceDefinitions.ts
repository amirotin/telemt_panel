import type { DataSourceDefinition } from "../sourceState";

export const connectionsSources = [
  { id: "stats", topic: "stats", required: true },
  { id: "connections", topic: "stats", required: false },
] as const satisfies readonly DataSourceDefinition[];

export const countersSources = [
  { id: "zero", endpoint: "/api/telemt/zero", required: true },
] as const satisfies readonly DataSourceDefinition[];

export const dcSources = [
  {
    id: "upstreams",
    topic: "upstreams",
    required: true,
    freshnessPath: "generated_at_epoch_secs",
  },
  { id: "runtime", topic: "runtime", required: false },
] as const satisfies readonly DataSourceDefinition[];

export const eventsSources = [
  { id: "events", topic: "runtime", required: true },
] as const satisfies readonly DataSourceDefinition[];

export const meSources = [
  {
    id: "upstreams",
    topic: "upstreams",
    required: true,
    freshnessPath: "generated_at_epoch_secs",
  },
  { id: "runtime", topic: "runtime", required: false },
  { id: "runtime_edge", topic: "runtime", required: false },
  { id: "minimal", topic: "runtime", required: false },
] as const satisfies readonly DataSourceDefinition[];

export const natSources = [
  { id: "nat", topic: "runtime", required: true },
] as const satisfies readonly DataSourceDefinition[];

export const securitySources = [
  { id: "security", topic: "security", required: true },
  { id: "tls", endpoint: "/api/telemt/tls-fingerprints", required: false },
] as const satisfies readonly DataSourceDefinition[];

export const upstreamsSources = [
  {
    id: "upstreams",
    topic: "upstreams",
    required: true,
    freshnessPath: "stats.generated_at_epoch_secs",
  },
  { id: "quality", topic: "runtime", required: false },
] as const satisfies readonly DataSourceDefinition[];

export const webSources = [
  { id: "status", topic: "web", required: true, capabilityPath: "status" },
  { id: "sessions", endpoint: "/api/telemt/web/sessions", required: false },
] as const satisfies readonly DataSourceDefinition[];
