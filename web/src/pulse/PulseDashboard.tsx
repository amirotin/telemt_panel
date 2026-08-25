import { useState } from "react";
import { cn } from "../lib/cn";
import { ru } from "../i18n/ru";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { EmptyState } from "../ui/EmptyState";
import { Sheet } from "../ui/Sheet";
import { ConfirmView } from "../ui/ConfirmView";
import { DisplayModeSwitch, useDisplayMode, type DisplayMode } from "../display-mode";
import { getWidgetDef, type FormFactor } from "./widgets/registry";
import { editorRows, visibleWidgetIds, type EditorRow } from "./layout";
import { usePulseLayout } from "./usePulseLayout";
import type { WidgetId } from "./types";

const SPAN_CLASSES: Record<FormFactor, string> = {
  stat: "",
  card: "",
  wide: "lg:col-span-3",
  table: "lg:col-span-3",
};

// PulseDashboard is the /pulse page: the user's layout, filtered by display
// mode, rendered through the widget registry — plus the "Настроить" catalog
// editor (06-ui.md §Пульс). No parallel widget list exists anywhere else;
// both the normal grid and the catalog below read from WIDGETS/usePulseLayout.
export function PulseDashboard() {
  const { mode } = useDisplayMode();
  const { layout, move, show, hide, reset } = usePulseLayout();
  const [configuring, setConfiguring] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);

  const visibleIds = visibleWidgetIds(layout, mode);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-text">{ru.pulse.title}</h1>
        <div className="flex items-center gap-2">
          <DisplayModeSwitch />
          <Button variant="secondary" onClick={() => setConfiguring((v) => !v)}>
            {configuring ? ru.pulse.done : ru.pulse.configure}
          </Button>
        </div>
      </div>

      {configuring ? (
        <LayoutEditor
          layout={layout}
          mode={mode}
          onMove={move}
          onShow={show}
          onHide={hide}
          onReset={() => setConfirmingReset(true)}
        />
      ) : visibleIds.length === 0 ? (
        <EmptyState title={ru.pulse.emptyLayoutTitle} description={ru.pulse.emptyLayoutDescription} />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {visibleIds.map((id) => {
            const def = getWidgetDef(id);
            if (!def) return null;
            const Widget = def.render;
            return (
              <div key={id} className={cn(SPAN_CLASSES[def.formFactor])}>
                <Widget onHide={def.hideable ? () => hide(id) : undefined} />
              </div>
            );
          })}
        </div>
      )}

      <Sheet open={confirmingReset} onClose={() => setConfirmingReset(false)} title={ru.pulse.reset}>
        <ConfirmView
          description={ru.pulse.resetConfirm}
          confirmLabel={ru.pulse.reset}
          pending={false}
          onCancel={() => setConfirmingReset(false)}
          onConfirm={() => {
            reset();
            setConfirmingReset(false);
          }}
        />
      </Sheet>
    </div>
  );
}

interface LayoutEditorProps {
  layout: WidgetId[];
  mode: DisplayMode;
  onMove: (id: WidgetId, direction: "up" | "down") => void;
  onShow: (id: WidgetId) => void;
  onHide: (id: WidgetId) => void;
  onReset: () => void;
}

// LayoutEditor lists every registry widget once, via layout.ts's editorRows
// — the user's current layout order first (so up/down arrows make sense)
// followed by the not-yet-shown widgets in registry order. A row whose
// widget is in the layout but filtered out by the current display mode
// (availableInMode: false) stays visible, greyed, with a "недоступно в
// текущем режиме" hint and its checkbox still toggleable — never silently
// dropped from the list (fix round 1, item 1).
function LayoutEditor({ layout, mode, onMove, onShow, onHide, onReset }: LayoutEditorProps) {
  const rows = editorRows(layout, mode);
  const shownRows = rows.filter((r) => r.shown);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-text-muted">{ru.pulse.catalogHint}</p>
      <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface">
        {rows.map((row) => (
          <LayoutEditorRow
            key={row.id}
            row={row}
            shownIndex={row.shown ? shownRows.findIndex((r) => r.id === row.id) : -1}
            shownCount={shownRows.length}
            onMove={onMove}
            onShow={onShow}
            onHide={onHide}
          />
        ))}
      </ul>
      <Button variant="ghost" onClick={onReset} className="self-start">
        {ru.pulse.reset}
      </Button>
    </div>
  );
}

interface LayoutEditorRowProps {
  row: EditorRow;
  /** Index within the shown subset — used for the up/down arrows' disabled bounds. -1 when not shown. */
  shownIndex: number;
  shownCount: number;
  onMove: (id: WidgetId, direction: "up" | "down") => void;
  onShow: (id: WidgetId) => void;
  onHide: (id: WidgetId) => void;
}

function LayoutEditorRow({ row, shownIndex, shownCount, onMove, onShow, onHide }: LayoutEditorRowProps) {
  const def = getWidgetDef(row.id);
  if (!def) return null;

  return (
    <li className={cn("flex items-center justify-between gap-2 px-3 py-2", !row.availableInMode && "opacity-60")}>
      <label className="flex min-w-0 flex-1 items-center gap-2">
        <input
          type="checkbox"
          checked={row.shown}
          disabled={row.shown && !def.hideable}
          onChange={() => (row.shown ? def.hideable && onHide(def.id) : onShow(def.id))}
          className="h-5 w-5 shrink-0"
        />
        <span className={cn("truncate text-sm", row.availableInMode ? "text-text" : "text-text-muted")}>
          {def.title}
        </span>
        {row.shown && !def.hideable && (
          <span className="shrink-0 text-xs text-text-faint">{ru.pulse.alwaysOn}</span>
        )}
        {!row.availableInMode && (
          <span className="shrink-0 text-xs text-text-faint">{ru.pulse.unavailableInMode}</span>
        )}
      </label>
      {row.shown && (
        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            aria-label={ru.pulse.moveUp}
            disabled={shownIndex === 0}
            onClick={() => onMove(row.id, "up")}
          >
            ↑
          </IconButton>
          <IconButton
            aria-label={ru.pulse.moveDown}
            disabled={shownIndex === shownCount - 1}
            onClick={() => onMove(row.id, "down")}
          >
            ↓
          </IconButton>
        </div>
      )}
    </li>
  );
}
