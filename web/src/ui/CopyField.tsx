import { useState } from "react";
import { cn } from "../lib/cn";
import { ru } from "../i18n/ru";
import { IconButton } from "./IconButton";

export interface CopyFieldProps {
  value: string;
  label?: string;
  className?: string;
}

// CopyField — monospace value (secret, IP, sub-link, server address) with
// a copy button and inline "copied" feedback. Used everywhere a value is
// meant to be pasted somewhere else rather than read.
export function CopyField({ value, label, className }: CopyFieldProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (insecure context, permission denied) —
      // silently no-op; the value is still selectable/visible in the field.
    }
  }

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {label && <span className="text-xs text-text-muted">{label}</span>}
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-text">{value}</span>
        <IconButton aria-label={copied ? ru.common.copied : ru.common.copy} onClick={copy}>
          {copied ? "✓" : "⧉"}
        </IconButton>
      </div>
    </div>
  );
}
