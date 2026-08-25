import { useStrings } from "../../i18n";
import { Card } from "../../ui/Card";
import { CardTitle } from "../../ui/Card";
import { IconInfo } from "../../ui/icons";

// ReadOnlyJsonView — the mobile fallback for the raw config view
// (06-ui.md: "на мобайле — read-only просмотр + подсказка"). Never pulls
// in the CodeMirror chunk (useIsDesktop.ts gates which of the two mounts,
// so the module import itself never happens on a phone) — plain
// pretty-printed JSON in a scrollable monospace block.
export function ReadOnlyJsonView({
  sections,
}: {
  sections: Record<string, unknown>;
}) {
  const s = useStrings();
  return (
    <div className="flex flex-col gap-2.5">
      <Card className="flex items-start gap-2.5">
        <IconInfo
          aria-hidden="true"
          className="mt-0.5 h-4 w-4 shrink-0 text-text-faint"
        />
        <p className="text-meta leading-relaxed text-text-muted">
          {s.server.config.rawEditorDesktopOnly}
        </p>
      </Card>
      <div className="overflow-hidden rounded-xl bg-surface p-4">
        <CardTitle className="mb-2.5">
          {s.server.config.rawEditorTitle}
        </CardTitle>
        <pre className="max-h-[60vh] overflow-auto rounded-md bg-surface-sunken p-3 font-mono text-[11.5px] leading-relaxed text-text-muted">
          {JSON.stringify(sections, null, 2)}
        </pre>
      </div>
    </div>
  );
}
