import { useState } from "react";
import { cn } from "../lib/cn";
import { useStrings } from "../i18n";
import { Button } from "../ui/Button";
import { CardList } from "../ui/Card";
import { IconButton } from "../ui/IconButton";
import { IconArrowDown, IconArrowUp } from "../ui/icons";
import { EmptyState } from "../ui/EmptyState";
import { Sheet } from "../ui/Sheet";
import { ConfirmView } from "../ui/ConfirmView";
import { useDisplayMode, type DisplayMode } from "../display-mode";
import { ViewMenu } from "./ViewMenu";
import { getWidgetDef, type WidgetSize } from "../pulse/widgets/registry";
import { editorRows, hiddenWidgetIds, visibleWidgetIds, type EditorRow } from "../pulse/layout";
import { usePulseLayout } from "../pulse/usePulseLayout";
import type { WidgetId } from "../pulse/types";

// Сводка's desktop grid is twelve columns with a 20px gutter (`lg:gap-5`),
// and each widget's registry `size` is the only thing that picks its span.
// Below `lg:` the grid is a single column and none of these classes apply —
// the phone layout is byte-for-byte what it was.
const SPAN_CLASSES: Record<WidgetSize, string> = {
  third: "lg:col-span-4",
  fiveTwelfths: "lg:col-span-5",
  half: "lg:col-span-6",
  sevenTwelfths: "lg:col-span-7",
  twoThirds: "lg:col-span-8",
  full: "lg:col-span-12",
  // A "tiles" widget emits its own cells; the page never wraps it.
  tiles: "",
};

// Сводка is a dashboard, not a reading surface, so it is not held to
// `--layout-readable-max` (06-ui.md: "приборная доска — нет") — but a
// twelve-column grid stretched across 2560px turns every tile into a
// letterbox. 1440px is the widest the grid still reads as a grid; beyond
// it the margins grow instead of the cells.
const CONTENT_MAX = "mx-auto w-full lg:max-w-[1440px]";

// OverviewPage is /overview — «Сводка», the configurable widget dashboard:
// the user's layout, filtered by display mode, rendered through the widget
// registry, plus the "Настроить" catalog editor and the «Скрытые блоки»
// list (06-ui.md §Информационная архитектура). It is the M3 «Пульс» page
// under its new name; /pulse is now the diagnostics hub (pulse/hub).
// No parallel widget list exists anywhere else; the grid, the catalog and
// the hidden list all read from WIDGETS/usePulseLayout.
//
// Header follows the prototype: the page title owns the first line on its
// own, and the density switch sits under it as a pill strip with «Настроить»
// as a quiet button at its right — previously the two controls shared the
// title's line and outweighed it. The switch lives HERE and only here: it
// filters this dashboard's widgets, and the Пульс hub shows a fixed set of
// eight cards it has no say over.
export function OverviewPage() {
  const s = useStrings();
  const { mode } = useDisplayMode();
  const { layout, move, show, hide, reset } = usePulseLayout();
  const [configuring, setConfiguring] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);

  const visibleIds = visibleWidgetIds(layout, mode);

  return (
    <div className={cn("flex flex-col gap-4", CONTENT_MAX)}>
      {/* Title and «Вид» share one line at every width (concept §16):
          the row wraps on a narrow phone rather than truncating either. */}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-title font-extrabold tracking-tight text-text">{s.overview.title}</h1>
        {configuring ? (
          <Button variant="ghost" size="sm" onClick={() => setConfiguring(false)} className="ml-auto">
            {s.pulse.done}
          </Button>
        ) : (
          <ViewMenu
            className="ml-auto"
            onConfigure={() => setConfiguring(true)}
            onReset={() => setConfirmingReset(true)}
          />
        )}
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
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12 lg:gap-5">
          {visibleIds.map((id) => {
            const def = getWidgetDef(id);
            if (!def) return null;
            const Widget = def.render;
            const onHide = def.hideable ? () => hide(id) : undefined;
            // A "tiles" widget IS its own set of grid cells — wrapping it
            // would nest a second grid inside a single column.
            if (def.size === "tiles") return <Widget key={id} onHide={onHide} />;
            return (
              <div key={id} className={cn("min-w-0", SPAN_CLASSES[def.size])}>
                <Widget onHide={onHide} />
              </div>
            );
          })}
        </div>
      )}

      {!configuring && <HiddenWidgets layout={layout} mode={mode} onShow={show} />}

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

interface HiddenWidgetsProps {
  layout: WidgetId[];
  mode: DisplayMode;
  onShow: (id: WidgetId) => void;
}

// HiddenWidgets — the prototype's «Скрытые блоки» footer: everything the
// registry offers that this layout does not currently show, each with a
// one-tap «показать». Without it the only way back to a widget the reader
// once hid was to open «Настроить» and hunt for its row, which is why the
// prototype put the list on the page itself.
//
// Widgets filtered out by the display MODE are deliberately absent: they are
// not hidden, they are out of scope for the current density, and offering
// «показать» for one would either lie (it stays invisible) or silently
// override the mode. The editor row already explains that case in words.
function HiddenWidgets({ layout, mode, onShow }: HiddenWidgetsProps) {
  const s = useStrings();
  const hidden = hiddenWidgetIds(layout, mode);
  if (hidden.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-micro font-semibold uppercase tracking-[0.06em] text-text-faint">
        {s.overview.hiddenTitle}
      </h2>
      <CardList>
        <ul className="flex flex-col">
          {hidden.map((id) => (
            <li
              key={id}
              className="flex min-h-[46px] items-center gap-3 border-b border-border py-2 last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate text-row text-text-muted">
                {s.pulse.widgets[id]}
              </span>
              <Button variant="ghost" size="sm" onClick={() => onShow(id)}>
                {s.overview.showWidget}
              </Button>
            </li>
          ))}
        </ul>
      </CardList>
    </section>
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
  "before:rounded-full before:bg-control-knob before:transition-[left] before:content-['']",
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
