import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { json } from "@codemirror/lang-json";

export interface RawConfigEditorProps {
  /** Initial JSON text — the editor owns its own text state after mount, never re-synced from a changing prop. */
  initialText: string;
  /** Called on every doc change with the parsed value, or null when the current text isn't valid JSON. */
  onChange: (parsed: Record<string, unknown> | null) => void;
}

// RawConfigEditor — the `lg:`-only raw view of GET /api/telemt/config's
// `sections` object (06-ui.md §Сервер: "raw-редактор — только lg:").
// api/openapi.yaml's TelemtConfig.sections is JSON, not a TOML string —
// there is no TOML text anywhere in this contract to edit, so this is a
// JSON editor over the sections object, not a pretend TOML file editor
// (task brief: "decide honestly"). Minimal CM6 wiring by hand (no
// @codemirror/commands/history — only @codemirror/state, @codemirror/view,
// @codemirror/lang-json are the task's approved dependencies): basic
// typing/selection/undo-by-browser works via CM6's own DOM input handling,
// but there is no Ctrl+Z history stack or Tab-indent keymap — see the task
// report's CodeMirror decision section for the tradeoff.
export function RawConfigEditor({ initialText, onChange }: RawConfigEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!hostRef.current) return;

    const state = EditorState.create({
      doc: initialText,
      extensions: [
        lineNumbers(),
        keymap.of([{ key: "Tab", run: () => true }]), // swallow Tab instead of moving focus out of the editor
        json(),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const text = update.state.doc.toString();
          try {
            const parsed: unknown = JSON.parse(text);
            onChangeRef.current(
              parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : null,
            );
          } catch {
            onChangeRef.current(null);
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    return () => view.destroy();
    // initialText intentionally excluded from deps — the editor owns its
    // own document after mount, matching every other controlled-uncontrolled
    // text-editor wrapper (a changing prop here would fight the user's
    // cursor position on every keystroke).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={hostRef}
      className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-surface font-mono text-sm [&_.cm-editor]:h-full [&_.cm-editor]:outline-none"
    />
  );
}
