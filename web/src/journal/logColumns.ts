// gridColumnsClass is the desktop log feed's column template, shared by
// LogList's header strip and every LogLineRow so the two can never drift
// apart. It lives in its own module rather than beside the row component
// because a component file that also exports a plain function breaks Fast
// Refresh (react-refresh/only-export-components).
//
// The unit column only exists in extended display mode, where LogLineRow
// actually renders a fourth cell — see 06-ui.md's density modes.
//
// The level column is 104px, not the prototype's 64px: its artboard prints
// the English tokens INFO/WARN/ERROR, while this build renders the Russian
// labels from ru.ts, and «ПРЕДУПРЕЖДЕНИЕ» overran a 64px cell straight into
// the message column.
export function gridColumnsClass(showUnit: boolean): string {
  return showUnit
    ? "lg:grid-cols-[82px_104px_minmax(0,140px)_1fr]"
    : "lg:grid-cols-[82px_104px_1fr]";
}
