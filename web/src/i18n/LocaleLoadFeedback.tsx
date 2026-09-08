import { setLocalePreference, useLocaleLoadState, useStrings } from "./store";

export function LocaleLoadFeedback() {
  const state = useLocaleLoadState();
  const s = useStrings();
  if (state.pending !== null) return <p role="status" className="mt-2 text-sm text-text-muted">{s.language.loading}</p>;
  const failed = state.error;
  if (failed === null) return null;
  return (
    <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-sm text-text-muted">
      <span>{s.language.loadFailed}</span>
      <button type="button" className="tap-target rounded-lg border border-border px-3 py-2 font-semibold text-text" onClick={() => void setLocalePreference(failed)}>{s.common.retry}</button>
    </div>
  );
}
