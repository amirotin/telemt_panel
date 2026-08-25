import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { json } from "@codemirror/lang-json";
import { findUnsafeIntegerLiterals } from "./unsafeIntegers";

export type RawConfigEditorResult =
  | { status: "ok"; value: Record<string, unknown> }
  | { status: "parse_error" }
  // Found before the value is even parsed — a huge integer literal has
  // already been silently rounded to the nearest representable double by
  // the time JSON.parse returns, so there is nothing left in a parsed
  // value to detect this from (unsafeIntegers.ts's own doc comment).
  | { status: "unsafe_integer"; tokens: string[] };

export interface RawConfigEditorProps {
  /** Initial JSON text — the editor owns its own text state after mount, never re-synced from a changing prop. */
  initialText: string;
  /** Called on every doc change with the outcome of validating the current text. */
  onChange: (result: RawConfigEditorResult) => void;
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

          // Checked on the source text before parsing — see this file's
          // own RawConfigEditorResult doc comment for why parsing first
          // would be too late.
          const unsafe = findUnsafeIntegerLiterals(text);
          if (unsafe.length > 0) {
            onChangeRef.current({ status: "unsafe_integer", tokens: unsafe });
            return;
          }

          try {
            const parsed: unknown = JSON.parse(text);
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
              onChangeRef.current({ status: "ok", value: parsed as Record<string, unknown> });
            } else {
              onChangeRef.current({ status: "parse_error" });
            }
          } catch {
            onChangeRef.current({ status: "parse_error" });
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
