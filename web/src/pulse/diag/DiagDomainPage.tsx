import { EmptyState } from "../../ui/EmptyState";
import { useStrings } from "../../i18n";
import type { DiagDomain } from "../types";
import { ConnectionsPage } from "./ConnectionsPage";
import { DcPage } from "./DcPage";
import { EventsPage } from "./EventsPage";
import { UpstreamsPage } from "./UpstreamsPage";
import { MePage } from "./MePage";
import { NatPage } from "./NatPage";
import { SecurityPage } from "./SecurityPage";
import { CountersPage } from "./CountersPage";

const PAGES: Record<DiagDomain, () => React.ReactElement> = {
  connections: ConnectionsPage,
  dc: DcPage,
  upstreams: UpstreamsPage,
  me: MePage,
  nat: NatPage,
  security: SecurityPage,
  counters: CountersPage,
  events: EventsPage,
};

function isDiagDomain(v: string): v is DiagDomain {
  return v in PAGES;
}

// DiagDomainPage dispatches the /pulse/diag/$domain route param to the
// matching full-composition page — the one place that maps a URL segment to
// a domain page component.
export function DiagDomainPage({ domain }: { domain: string }) {
  const s = useStrings();
  if (!isDiagDomain(domain)) {
    return <EmptyState title={s.diag.notFoundTitle} />;
  }
  const Page = PAGES[domain];
  return <Page />;
}
