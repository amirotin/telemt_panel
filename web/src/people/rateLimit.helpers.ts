// Telemt 3.5.8 bounds user rates at 100,000,000,000 bps. Older and
// unrecognized versions retain their existing validation contract.
export function userRateLimitMaxMbps(version: string | undefined): number | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version?.trim() ?? "");
  if (!match) return undefined;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  const atLeast358 = major > 3 || (major === 3 && (minor > 5 || (minor === 5 && (patch > 8 || (patch === 8 && !match[4])))));
  return atLeast358 ? 100_000 : undefined;
}
