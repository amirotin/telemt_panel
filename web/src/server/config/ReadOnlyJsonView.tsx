import { ru } from "../../i18n/ru";

// ReadOnlyJsonView — the mobile fallback for the raw config view
// (06-ui.md: "на мобайле — read-only просмотр + подсказка"). Never pulls
// in the CodeMirror chunk (useIsDesktop.ts gates which of the two mounts,
// so the module import itself never happens on a phone) — plain
// pretty-printed JSON in a scrollable monospace block.
export function ReadOnlyJsonView({ sections }: { sections: Record<string, unknown> }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-text-faint">{ru.server.config.rawEditorDesktopOnly}</p>
      <pre className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-surface p-3 font-mono text-xs text-text">
        {JSON.stringify(sections, null, 2)}
      </pre>
    </div>
  );
}
