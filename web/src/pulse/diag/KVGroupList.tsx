import { KVRow } from "../../ui/KVRow";
import { EmptyState } from "../../ui/EmptyState";
import { ru } from "../../i18n/ru";
import type { KVGroup } from "./rows";

// KVGroupList renders every Диагностика page's actual content — one bordered
// section per group, KVRow per leaf (06-ui.md: "полный состав данных
// каталога — KVRow-группы"). The one shared renderer every domain page's
// helpers.ts feeds groups into.
export function KVGroupList({ groups }: { groups: KVGroup[] }) {
  if (groups.length === 0) {
    return <EmptyState title={ru.diag.emptyTitle} description={ru.diag.emptyDescription} />;
  }
  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <section key={g.title} className="rounded-xl border border-border bg-surface p-4">
          <h2 className="mb-2 text-sm font-semibold text-text">{g.title}</h2>
          <div className="flex flex-col">
            {g.rows.map((r) => (
              <KVRow key={r.key} label={r.label} value={r.value} monospace={r.monospace} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
