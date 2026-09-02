import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";

const tomlEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "rgb(var(--surface-sunken))",
    color: "rgb(var(--text))",
    fontSize: "14px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-family-mono)",
    lineHeight: "1.65",
    overflow: "auto",
  },
  ".cm-content": {
    minHeight: "360px",
    padding: "14px 0",
    caretColor: "rgb(var(--accent))",
  },
  ".cm-gutters": {
    backgroundColor: "rgb(var(--surface-sunken))",
    color: "rgb(var(--text-faint))",
    border: "none",
    borderRight: "1px solid rgb(var(--border))",
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "rgb(var(--surface) / 0.55)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "rgb(var(--accent))" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "rgb(var(--accent) / 0.28)",
  },
});

export function TomlConfigEditor({
  initialText,
  onChange,
  labelledBy,
}: {
  initialText: string;
  onChange: (text: string) => void;
  labelledBy?: string;
}) {
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
        tomlEditorTheme,
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    return () => view.destroy();
    // The editor owns its document until the projection revision changes
    // and its parent intentionally remounts it with a new key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={hostRef}
      role="textbox"
      aria-multiline="true"
      aria-labelledby={labelledBy}
      className="h-full min-h-[420px] overflow-hidden rounded-xl border border-border bg-surface-sunken [&_.cm-editor]:h-full"
    />
  );
}
