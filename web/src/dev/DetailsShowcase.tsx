import { useState } from "react";
import { Chip } from "../ui";
import { SectionLabel } from "../ui/SectionLabel";
import { DisplayModeSwitch } from "../display-mode";
import { DetailPage } from "../pulse/details-builder/DetailPage";
import type { DataSourceDefinition } from "../pulse/details-builder/model";
import {
  aggregateSources,
  resolveQuerySource,
  type PageSourcesState,
  type SourceStatus,
} from "../pulse/details-builder/sources";
import {
  devCountersPage,
  devDcPage,
  devMeQualityPage,
  devPayloads,
  devTlsPage,
} from "./detailsDefinitions";

// A FIXED clock. Every relative age on this page is measured from it, so a
// screenshot taken now and one taken tomorrow are byte-identical — the
// screenshot checkpoint (§27.1) compares PNGs, and a ticking "2 сек назад"
// would make every one of them differ.
const FIXED_NOW = 1_756_000_000_000 + 125_000;
const FRESH_AT = 1_756_000_000_000;

type PageId = "dc" | "me" | "tls" | "counters";

const PAGES: { id: PageId; label: string }[] = [
  { id: "dc", label: "DC" },
  { id: "me", label: "ME quality" },
  { id: "tls", label: "Security / TLS" },
  { id: "counters", label: "Counters" },
];

// Every §14 state, each produced by the REAL state machine
// (resolveQuerySource) from the input that causes it — not by hand-writing
// a SourceState. `unsupported` and `stale` are the two Task 1's live stand
// could not reach, which is why they are reachable here.
const STATES: { id: SourceStatus; label: string }[] = [
  { id: "loading", label: "loading" },
  { id: "ready", label: "ready" },
  { id: "stale", label: "stale" },
  { id: "disabled", label: "disabled" },
  { id: "unsupported", label: "unsupported" },
  { id: "error", label: "error" },
  { id: "empty", label: "empty" },
];

function sourcesFor(
  definitions: readonly DataSourceDefinition[],
  status: SourceStatus,
  payload: unknown,
): PageSourcesState {
  const id = definitions[0]?.id ?? "source";
  const input = (() => {
    switch (status) {
      case "loading":
        return { kind: "query" as const, isPending: true, isError: false };
      case "stale":
        // A failed refetch on top of a payload that is still worth showing.
        return {
          kind: "query" as const,
          isPending: false,
          isError: true,
          error: { code: "telemt_unreachable" },
          data: payload,
          dataUpdatedAt: FRESH_AT,
        };
      case "disabled":
        return {
          kind: "query" as const,
          isPending: false,
          isError: true,
          error: { code: "capability_unavailable" },
        };
      case "unsupported":
        return {
          kind: "query" as const,
          isPending: false,
          isError: true,
          error: { code: "capability_absent" },
        };
      case "error":
        return {
          kind: "query" as const,
          isPending: false,
          isError: true,
          error: { code: "internal_error" },
        };
      case "empty":
        return { kind: "query" as const, isPending: false, isError: false, data: {} };
      default:
        return {
          kind: "query" as const,
          isPending: false,
          isError: false,
          data: payload,
          dataUpdatedAt: FRESH_AT,
        };
    }
  })();
  return aggregateSources(definitions, { [id]: resolveQuerySource(id, input) });
}

// /dev/details — the DEV-only harness for the Details builder. It renders
// the base renderers over the production-sized fixtures and lets every
// §14 source state be selected directly, which is the only way `stale` and
// `unsupported` are reachable without a specific Telemt build.
export function DetailsShowcase() {
  const [page, setPage] = useState<PageId>("dc");
  const [status, setStatus] = useState<SourceStatus>("ready");

  const withData = status === "ready" || status === "stale";

  const body = (() => {
    switch (page) {
      case "dc":
        return (
          <DetailPage
            definition={devDcPage}
            payload={withData ? devPayloads.dc : null}
            sources={sourcesFor(devDcPage.sources, status, devPayloads.dc)}
            breadcrumb="PULSE / DETAILS"
            nowMs={FIXED_NOW}
          />
        );
      case "me":
        return (
          <DetailPage
            definition={devMeQualityPage}
            payload={withData ? devPayloads.meQuality : null}
            sources={sourcesFor(devMeQualityPage.sources, status, devPayloads.meQuality)}
            breadcrumb="PULSE / DETAILS"
            nowMs={FIXED_NOW}
          />
        );
      case "tls":
        return (
          <DetailPage
            definition={devTlsPage}
            payload={withData ? devPayloads.tls : null}
            sources={sourcesFor(devTlsPage.sources, status, devPayloads.tls)}
            breadcrumb="PULSE / DETAILS"
            nowMs={FIXED_NOW}
          />
        );
      case "counters":
        return (
          <DetailPage
            definition={devCountersPage}
            payload={withData ? devPayloads.counters : null}
            sources={sourcesFor(devCountersPage.sources, status, devPayloads.counters)}
            breadcrumb="PULSE / DETAILS"
            nowMs={FIXED_NOW}
          />
        );
    }
  })();

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4">
      <div className="flex flex-col gap-2" data-testid="dev-details-switcher">
        <SectionLabel>page</SectionLabel>
        <div className="flex flex-wrap gap-2">
          {PAGES.map((p) => (
            <Chip key={p.id} active={p.id === page} onClick={() => setPage(p.id)}>
              {p.label}
            </Chip>
          ))}
        </div>
        <SectionLabel>source state</SectionLabel>
        <div className="flex flex-wrap gap-2">
          {STATES.map((st) => (
            <Chip key={st.id} active={st.id === status} onClick={() => setStatus(st.id)}>
              {st.label}
            </Chip>
          ))}
        </div>
        <SectionLabel>display mode</SectionLabel>
        <DisplayModeSwitch />
      </div>
      {body}
    </div>
  );
}

export default DetailsShowcase;
