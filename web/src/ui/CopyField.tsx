import { useRef, useState } from "react";
import { cn } from "../lib/cn";
import { ru } from "../i18n/ru";
import { IconButton } from "./IconButton";
import { copyText } from "../lib/copyText";
import { pushToast } from "./Toast";

export interface CopyFieldProps {
  value: string;
  label?: string;
  className?: string;
}

// CopyField — monospace value (secret, IP, sub-link, server address) with
// a copy button and inline "copied" feedback. Used everywhere a value is
// meant to be pasted somewhere else rather than read.
//
// A plain-HTTP LAN deployment (no TLS cert on a router's admin panel) is a
// primary profile for this app, and the async Clipboard API only works in
// a secure context — so a bare navigator.clipboard.writeText() call
// silently does nothing there. copyText() falls back to
// document.execCommand("copy"), and when even that fails this component
// selects the value's text (so a manual Ctrl+C still works) and tells the
// user to do it themselves, rather than pretending the copy succeeded.
export function CopyField({ value, label, className }: CopyFieldProps) {
  const [copied, setCopied] = useState(false);
  const valueRef = useRef<HTMLSpanElement>(null);

  async function copy() {
    const result = await copyText(value);
    if (result === "failed") {
      selectValueText();
      pushToast(ru.common.copyManually, "error");
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function selectValueText() {
    const el = valueRef.current;
    const selection = window.getSelection();
    if (!el || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {label && <span className="text-xs text-text-muted">{label}</span>}
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
        <span
          ref={valueRef}
          className="min-w-0 flex-1 truncate font-mono text-sm text-text"
        >
          {value}
        </span>
        <IconButton aria-label={copied ? ru.common.copied : ru.common.copy} onClick={copy}>
          {copied ? "✓" : "⧉"}
        </IconButton>
      </div>
    </div>
  );
}
