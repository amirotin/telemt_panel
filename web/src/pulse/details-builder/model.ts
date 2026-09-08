import type { DisplayMode } from "../../display-mode/mode";
import type { FormatterName } from "../formatting";

export type FieldUnit = "percent" | "milliseconds" | "seconds" | "bytes" | "timestamp";

/** Resolved catalog metadata retained until the field-catalog audit. */
export interface FieldDefinition {
  path: string;
  label?: string;
  shortLabel?: string;
  description: string;
  format?: FormatterName;
  unit?: FieldUnit;
  sensitive?: boolean;
  nullMeaning?: string;
  zeroMeaning?: string;
  minMode?: DisplayMode;
}
