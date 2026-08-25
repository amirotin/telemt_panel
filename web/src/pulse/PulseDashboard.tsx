import { useState } from "react";
import { cn } from "../lib/cn";
import { ru } from "../i18n/ru";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { EmptyState } from "../ui/EmptyState";
import { Sheet } from "../ui/Sheet";
import { ConfirmView } from "../people/ConfirmView";
import { DisplayModeSwitch, useDisplayMode } from "../display-mode";
import { WIDGETS, getWidgetDef, type FormFactor } from "./widgets/registry";
import { visibleWidgetIds } from "./layout";
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
  onMove: (id: WidgetId, direction: "up" | "down") => void;
  onShow: (id: WidgetId) => void;
  onHide: (id: WidgetId) => void;
  onReset: () => void;
}

// LayoutEditor lists every registry widget once, in the user's current
// layout order first (so up/down arrows make sense) followed by the
// not-yet-shown widgets in registry order — checking one appends it to the
// end of the layout, matching layout.ts's showWidget.
function LayoutEditor({ layout, onMove, onShow, onHide, onReset }: LayoutEditorProps) {
  const shown = layout.map((id) => getWidgetDef(id)).filter((d) => d !== undefined);
  const hiddenWidgets = WIDGETS.filter((w) => !layout.includes(w.id));

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-text-muted">{ru.pulse.catalogHint}</p>
      <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface">
        {shown.map((def, index) => (
          <li key={def.id} className="flex items-center justify-between gap-2 px-3 py-2">
            <label className="flex min-w-0 flex-1 items-center gap-2">
              <input
                type="checkbox"
                checked
                disabled={!def.hideable}
                onChange={() => def.hideable && onHide(def.id)}
                className="h-5 w-5 shrink-0"
              />
              <span className="truncate text-sm text-text">{def.title}</span>
              {!def.hideable && (
                <span className="shrink-0 text-xs text-text-faint">{ru.pulse.alwaysOn}</span>
              )}
            </label>
            <div className="flex shrink-0 items-center gap-1">
              <IconButton
                aria-label={ru.pulse.moveUp}
                disabled={index === 0}
                onClick={() => onMove(def.id, "up")}
              >
                ↑
              </IconButton>
              <IconButton
                aria-label={ru.pulse.moveDown}
                disabled={index === shown.length - 1}
                onClick={() => onMove(def.id, "down")}
              >
                ↓
              </IconButton>
            </div>
          </li>
        ))}
        {hiddenWidgets.map((def) => (
          <li key={def.id} className="flex items-center justify-between gap-2 px-3 py-2">
            <label className="flex min-w-0 flex-1 items-center gap-2">
              <input
                type="checkbox"
                checked={false}
                onChange={() => onShow(def.id)}
                className="h-5 w-5 shrink-0"
              />
              <span className="truncate text-sm text-text-muted">{def.title}</span>
            </label>
          </li>
        ))}
      </ul>
      <Button variant="ghost" onClick={onReset} className="self-start">
        {ru.pulse.reset}
      </Button>
    </div>
  );
}
