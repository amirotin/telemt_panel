import { Card } from "../../ui/Card";
import { KVRow } from "../../ui/KVRow";
import { SectionLabel } from "../../ui/SectionLabel";
import { EmptyState } from "../../ui/EmptyState";
import { useStrings } from "../../i18n";
import type { KVGroup } from "./rows";

// KVGroupList renders a list of KVGroups — one card per group under the
// prototype's uppercase section caption, KVRow per leaf.
//
// It used to be every Диагностика page's body. Since the M4 details-builder
// wave those pages are declarative DetailPages built from DescribedRow
// lists, and this component's ONLY remaining consumer is
// server/security/SecurityPage — the read-only /server/security screen,
// which is not a Details page and was deliberately left alone: migrating a
// screen this wave never touched onto the builder is a redesign, not a
// cleanup. Kept here rather than moved because securityGroups (its input)
// lives in security.helpers.ts, which the Details Security page also uses.
export function KVGroupList({ groups }: { groups: KVGroup[] }) {
  const s = useStrings();
  if (groups.length === 0) {
    return <EmptyState title={s.diag.emptyTitle} description={s.diag.emptyDescription} />;
  }
  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <section key={g.title} className="flex flex-col gap-1.5">
          <SectionLabel>{g.title}</SectionLabel>
          <Card className="px-4 py-0.5">
            {g.rows.map((r) => (
              <KVRow key={r.key} label={r.label} value={r.value} monospace={r.monospace} />
            ))}
          </Card>
        </section>
      ))}
    </div>
  );
}
