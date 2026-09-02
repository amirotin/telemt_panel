const HOST_COMMAND_PREFIXES = [
  "systemctl ",
  "rc-service ",
  "/etc/init.d/",
  "docker restart ",
] as const;

export function isCopyableHostCommand(value: string): boolean {
  const normalized = value.trim();
  return HOST_COMMAND_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
