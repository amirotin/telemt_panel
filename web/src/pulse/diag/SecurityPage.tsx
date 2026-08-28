import { useNavigate } from "@tanstack/react-router";
import { useSnapshot } from "../../realtime";
import type { SecurityTopic } from "../../realtime/topics";
import { DetailPage } from "../details-builder/DetailPage";
import { securityPageDefinition } from "../details-builder/definitions/security";
import { TLS_FINGERPRINTS_ENDPOINT } from "../details-builder/fieldCatalog";
import { useDetailSources, type DetailSourceInput } from "../details-builder/sources";
import { useTlsFingerprintsQuery } from "../widgets/useTlsFingerprints";
import { securityPageData } from "./security.helpers";

// SecurityPage — /pulse/diag/security, spec §23.3. The four TLS rankings
// that used to be ~2 000 flat rows are now four independent
// RankingSections; posture, whitelist and effective limits keep their own
// tab, which is also the one tab that has data when runtime_edge is off.
//
// The TLS query is passed to the source resolver RAW (not through
// `resolveTlsFingerprintsQuery`) so that ruling R5's disabled-vs-unsupported
// split is made in ONE place for the whole builder — sources.test.ts pins
// the two mappings to the same answers case by case.
export function SecurityPage() {
  const topic = useSnapshot<SecurityTopic>("security");
  const tls = useTlsFingerprintsQuery();
  const navigate = useNavigate();

  const payload = securityPageData(topic.data, tls.data?.data ?? undefined);

  const inputs: Record<string, DetailSourceInput> = {
    security: { kind: "topic", snapshot: topic },
    tls: {
      kind: "query",
      isPending: tls.isPending,
      isError: tls.isError,
      error: tls.error ?? null,
      data: tls.data,
      dataUpdatedAt: tls.dataUpdatedAt,
      gated: tls.data ?? null,
    },
  };
  const sources = useDetailSources(securityPageDefinition.sources, inputs);

  return (
    <DetailPage
      definition={securityPageDefinition}
      payload={payload}
      sources={sources}
      endpoint={TLS_FINGERPRINTS_ENDPOINT}
      onBack={() => void navigate({ to: "/pulse" })}
      onRetry={() => tls.refetch()}
      disabledHints={{ tls: "runtime_edge" }}
    />
  );
}
