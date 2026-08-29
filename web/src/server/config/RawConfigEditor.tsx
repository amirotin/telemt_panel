import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { json } from "@codemirror/lang-json";
import { findUnsafeIntegerLiterals } from "./unsafeIntegers";

// tokenTheme paints CodeMirror's own chrome from the design tokens instead
// of its stock light palette (which rendered a white slab in the middle of
// a dark page). Every value is a `rgb(var(--token))`, so the editor follows
// [data-theme] with no second theme object and no re-mount on theme change
// — that is what makes it correct in all four themes (Тёмная, Светлая,
// «Мокко», «Пергамент») without a per-theme mapping. The rules below cover
// every surface CM6's base theme splits into `&light`/`&dark` variants —
// gutters, active line, cursor, selection — so `EditorView.theme`'s `dark`
// flag, which is a static boolean and could not follow the switcher
// anyway, has nothing left to decide; the extensions in use here (line
// numbers + JSON) render no panels, tooltips or search matches.
// No syntax highlighting: that needs @codemirror/language, which is only a
// transitive dependency here and web/README.md's dependency rule keeps the
// direct list to the three approved @codemirror packages.
const tokenTheme = EditorView.theme({
  "&": {
    backgroundColor: "rgb(var(--surface-sunken))",
    color: "rgb(var(--text))",
    fontSize: "12px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-family-mono)",
    lineHeight: "1.6",
  },
  ".cm-content": {
    padding: "12px 0",
    caretColor: "rgb(var(--accent))",
  },
  ".cm-gutters": {
    backgroundColor: "rgb(var(--surface-sunken))",
    color: "rgb(var(--text-faint))",
    border: "none",
    borderRight: "1px solid rgb(var(--border))",
  },
  ".cm-activeLine": { backgroundColor: "rgb(var(--surface) / 0.55)" },
  ".cm-activeLineGutter": {
    backgroundColor: "rgb(var(--surface) / 0.55)",
    color: "rgb(var(--text-muted))",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "rgb(var(--accent))" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    {
      backgroundColor: "rgb(var(--accent) / 0.28)",
    },
});

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
export function RawConfigEditor({
  initialText,
  onChange,
}: RawConfigEditorProps) {
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
        tokenTheme,
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
            if (
              parsed !== null &&
              typeof parsed === "object" &&
              !Array.isArray(parsed)
            ) {
              onChangeRef.current({
                status: "ok",
                value: parsed as Record<string, unknown>,
              });
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
      className="max-h-[60vh] overflow-auto rounded-xl border border-border bg-surface-sunken [&_.cm-editor]:h-full [&_.cm-editor]:outline-none"
    />
  );
}
