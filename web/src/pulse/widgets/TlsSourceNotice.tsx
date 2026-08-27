import { ErrorState } from "../../ui/ErrorState";
import { errorMessage, useStrings } from "../../i18n";
import { Gated } from "../../caps/Gated";
import { GatedNote } from "../GatedNote";
import type { TlsFingerprintsState } from "./tlsFingerprints.helpers";

export interface TlsSourceNoticeProps {
  state: TlsFingerprintsState & { refetch: () => void };
  /**
   * `note` — the recessed inline block used inside a widget card or under a
   * page's groups; `card` — the standalone caps/Gated card the Сервер →
   * Безопасность screen already used for this source.
   */
  as: "note" | "card";
}

// TlsSourceNotice renders whatever the TLS fingerprints source has to say
// when it has no data: switched off, absent from this build, or broken.
//
// It exists as one component because all three call sites (the dashboard
// widget and both Security screens) must agree on the distinction that
// motivated M4 task 1 in the first place — "runtime_edge is off" and
// "Telemt cannot be reached" look nothing alike to an operator, and the
// third state, "this build never had the route" (ruling R5), points at an
// update rather than at a setting. A page that rendered only the gated
// branch would make an outage look like four sections that simply do not
// exist.
//
// Returns null while loading and when data is present — the caller owns
// those, since only it knows what a skeleton or a populated table looks
// like in its own layout.
export function TlsSourceNotice({ state, as }: TlsSourceNoticeProps) {
  const s = useStrings();

  switch (state.status) {
    case "disabled":
      return as === "card" ? (
        <Gated enabled={false} reason={state.reason} hint="runtime_edge" />
      ) : (
        <GatedNote reason={state.reason} hint="runtime_edge" />
      );
    case "unsupported":
      return as === "card" ? (
        <Gated enabled={false} variant="unsupported" hint="telemt_outdated" />
      ) : (
        <GatedNote variant="unsupported" hint="telemt_outdated" />
      );
    case "error":
      return <ErrorState message={errorMessage(s, state.code)} onRetry={state.refetch} />;
    default:
      return null;
  }
}
