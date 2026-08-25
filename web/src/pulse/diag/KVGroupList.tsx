import { Card } from "../../ui/Card";
import { KVRow } from "../../ui/KVRow";
import { SectionLabel } from "../../ui/SectionLabel";
import { EmptyState } from "../../ui/EmptyState";
import { ru } from "../../i18n/ru";
import type { KVGroup } from "./rows";

// KVGroupList renders every Диагностика page's actual content — one card
// per group under the prototype's uppercase section caption, KVRow per leaf
// (06-ui.md: "полный состав данных каталога — KVRow-группы"). The one
// shared renderer every domain page's helpers.ts feeds groups into.
export function KVGroupList({ groups }: { groups: KVGroup[] }) {
  if (groups.length === 0) {
    return <EmptyState title={ru.diag.emptyTitle} description={ru.diag.emptyDescription} />;
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
