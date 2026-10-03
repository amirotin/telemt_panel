// Telemt widens some f32 settings before JSON serialization. Compact only
// exact f32 values, retaining enough digits to recover the same f32.
export function formatConfigNumber(value: unknown, dataType: string): string {
  if (value === undefined) return "";
  if (
    dataType === "f32" &&
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.fround(value) === value
  ) {
    for (let precision = 1; precision <= 9; precision++) {
      const compact = Number(value.toPrecision(precision));
      if (Math.fround(compact) === value) return String(compact);
    }
  }
  return String(value);
}
