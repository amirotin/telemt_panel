import { useRef, useState } from "react";
import { cn } from "../lib/cn";
import { ru } from "../i18n/ru";
import { IconButton } from "./IconButton";
import { IconCheck, IconCopy } from "./icons";
import { copyText } from "../lib/copyText";
import { pushToast } from "./Toast";

export interface CopyFieldProps {
  value: string;
  label?: string;
  className?: string;
  /** Stable hook for e2e (Playwright) — not read by anything else here. */
  "data-testid"?: string;
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
export function CopyField({ value, label, className, "data-testid": testId }: CopyFieldProps) {
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
      {label && <span className="text-micro font-medium uppercase tracking-[0.06em] text-text-faint">{label}</span>}
      <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-1.5">
        <span
          ref={valueRef}
          data-testid={testId}
          className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-text"
        >
          {value}
        </span>
        <IconButton
          aria-label={copied ? ru.common.copied : ru.common.copy}
          onClick={copy}
          className={copied ? "text-ok" : undefined}
        >
          {copied ? <IconCheck /> : <IconCopy />}
        </IconButton>
      </div>
    </div>
  );
}
