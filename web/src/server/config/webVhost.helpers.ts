export function webVhostDomains(vhost: Record<string, unknown>): string[] {
  return Array.isArray(vhost["hosts"])
    ? vhost["hosts"].filter((host): host is string => typeof host === "string")
    : typeof vhost["host"] === "string" ? [vhost["host"]] : [];
}
