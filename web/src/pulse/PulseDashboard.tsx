import { useState } from "react";
import { cn } from "../lib/cn";
import { useStrings } from "../i18n";
import { Button } from "../ui/Button";
import { CardList } from "../ui/Card";
import { IconButton } from "../ui/IconButton";
import { IconArrowDown, IconArrowUp, IconSettings } from "../ui/icons";
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
//
// Header follows the prototype: the page title owns the first line on its
// own, and the density switch sits under it as a pill strip with «Настроить»
// as a quiet button at its right — previously the two controls shared the
// title's line and outweighed it.
export function PulseDashboard() {
  const s = useStrings();
  const { mode } = useDisplayMode();
  const { layout, move, show, hide, reset } = usePulseLayout();
  const [configuring, setConfiguring] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);

  const visibleIds = visibleWidgetIds(layout, mode);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <h1 className="text-title font-extrabold tracking-tight text-text">{s.pulse.title}</h1>
        {/* Three density chips plus «Настроить» do not fit 360px on one
            line, so the row wraps on a phone and only pushes the button to
            the far right once there is room for it. */}
        <div className="flex flex-wrap items-center gap-2">
          <DisplayModeSwitch />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfiguring((v) => !v)}
            className="ml-auto"
          >
            {!configuring && <IconSettings className="h-4 w-4" />}
            {configuring ? s.pulse.done : s.pulse.configure}
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
        <EmptyState title={s.pulse.emptyLayoutTitle} description={s.pulse.emptyLayoutDescription} />
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

      <Sheet open={confirmingReset} onClose={() => setConfirmingReset(false)} title={s.pulse.reset}>
        <ConfirmView
          description={s.pulse.resetConfirm}
          confirmLabel={s.pulse.reset}
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
  const s = useStrings();
  const rows = editorRows(layout, mode);
  const shownRows = rows.filter((r) => r.shown);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-meta text-text-muted">{s.pulse.catalogHint}</p>
      <CardList>
        <ul className="flex flex-col">
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
      </CardList>
      <Button variant="ghost" size="sm" onClick={onReset} className="self-start">
        {s.pulse.reset}
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

// The visibility control stays a real <input type="checkbox"> — restyled
// with `appearance-none` into the prototype's 42×25 pill switch rather than
// swapped for a role="switch" button, so it keeps the checkbox role that
// assistive tech (and e2e/mobile.spec.ts's `.uncheck()`) addresses it by.
const SWITCH_CLASSES = [
  "relative h-[25px] w-[42px] shrink-0 cursor-pointer appearance-none rounded-full",
  "bg-surface-3 transition-colors checked:bg-accent-strong",
  "disabled:cursor-not-allowed disabled:opacity-50",
  "before:absolute before:left-[2.5px] before:top-[2.5px] before:h-5 before:w-5",
  "before:rounded-full before:bg-white before:transition-[left] before:content-['']",
  "checked:before:left-[19.5px]",
].join(" ");

function LayoutEditorRow({ row, shownIndex, shownCount, onMove, onShow, onHide }: LayoutEditorRowProps) {
  const s = useStrings();
  const def = getWidgetDef(row.id);
  if (!def) return null;

  const hint = !row.availableInMode
    ? s.pulse.unavailableInMode
    : row.shown && !def.hideable
      ? s.pulse.alwaysOn
      : null;

  return (
    // Row markup mirrors ui/Card's CardRow, inlined because this one has to
    // be an <li> inside the editor's list.
    <li
      className={cn(
        "flex min-h-[46px] items-center gap-3 border-b border-border py-2 last:border-b-0",
        !row.availableInMode && "opacity-60",
      )}
    >
      <label className="flex min-w-0 flex-1 items-center gap-3">
        <input
          type="checkbox"
          checked={row.shown}
          disabled={row.shown && !def.hideable}
          onChange={() => (row.shown ? def.hideable && onHide(def.id) : onShow(def.id))}
          className={SWITCH_CLASSES}
        />
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-row font-medium",
              row.availableInMode ? "text-text" : "text-text-muted",
            )}
          >
            {s.pulse.widgets[def.id]}
          </span>
          {hint && <span className="block truncate text-micro text-text-muted">{hint}</span>}
        </span>
      </label>
      {row.shown && (
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton
            aria-label={s.pulse.moveUp}
            disabled={shownIndex === 0}
            onClick={() => onMove(row.id, "up")}
            className="text-[16px]"
          >
            <IconArrowUp />
          </IconButton>
          <IconButton
            aria-label={s.pulse.moveDown}
            disabled={shownIndex === shownCount - 1}
            onClick={() => onMove(row.id, "down")}
            className="text-[16px]"
          >
            <IconArrowDown />
          </IconButton>
        </div>
      )}
    </li>
  );
}
