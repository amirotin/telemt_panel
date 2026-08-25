import type { UpdatesStatus } from "../../lib/api/generated/types.gen";

export type ReleaseItem = UpdatesStatus["targets"][number]["releases"][number];

// pickLatestRelease finds the update the admin would actually apply — the
// engine's own BuildReleasesView (internal/update/releases.go) sorts
// releases semver-descending and marks every entry newer than the running
// version, so the first `newer: true` entry is both the newest release and
// the one worth surfacing as "an update is available". No entries marked
// newer means the installed version is already current.
export function pickLatestRelease(releases: ReleaseItem[]): ReleaseItem | null {
  return releases.find((r) => r.newer) ?? null;
}
