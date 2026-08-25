// quotaFillClass mirrors the prototype's three-step quota/activity bar:
// accent under 80%, amber from 80%, the solid "exhausted" red at 100%.
// Lives beside QuotaBar rather than inside it so the People row and the
// Инспектор can paint the same thresholds without importing a component
// module just for a class name.
export function quotaFillClass(ratio: number, unlimited: boolean): string {
  if (unlimited) return "bg-accent";
  if (ratio >= 1) return "bg-error-strong";
  if (ratio >= 0.8) return "bg-warn";
  return "bg-accent";
}
