import { buildConfigPatch } from "./configPatch.helpers";
import { rebaseEdits } from "./rebaseEdits";

// A PATCH can finish while the admin is already making the next edit. Keep
// only that post-submit delta and apply it over Telemt's freshly returned
// configuration; successful saves must not erase typing that happened while
// the request was in flight.
export function preserveLateConfigEdits(
  fresh: Record<string, unknown>,
  submittedDraft: Record<string, unknown>,
  latestDraft: Record<string, unknown>,
): Record<string, unknown> {
  const latePatch = buildConfigPatch(submittedDraft, latestDraft);
  if (Object.keys(latePatch).length === 0) return fresh;
  return rebaseEdits(fresh, latePatch, []).edited;
}
