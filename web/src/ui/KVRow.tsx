import type { ReactNode } from "react";
import { DescribedRow } from "./DescribedRow";

export interface KVRowProps {
  label: string;
  value: ReactNode;
  monospace?: boolean;
  className?: string;
}

// KVRow — key/value row for the screens that label their own rows in
// Russian (config quick settings, /server/security, /server/platform, the
// Диагностика KVGroup dumps). It is now a thin wrapper over DescribedRow,
// so there is ONE scalar-row layout in the app rather than two that drift:
// the only difference is that a KVRow has a human label instead of a Telemt
// field name (`nameStyle="label"`) and no description under it.
//
// The one visible change from the standalone version: a long value wraps
// instead of being truncated with an ellipsis (spec §13.2 — a value must
// stay fully readable and selectable, and never widen the viewport). The
// value weight is deliberately NOT changed: `nameStyle="label"` leaves
// DescribedRow's emphasis off, so these screens read exactly as before.
export function KVRow({ label, value, monospace, className }: KVRowProps) {
  return (
    <DescribedRow
      nameStyle="label"
      name={label}
      value={value}
      monospaceValue={monospace}
      numeric
      className={className}
    />
  );
}
