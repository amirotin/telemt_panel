// The §15.1 layout thresholds, as design tokens.
//
// styles/tokens.css declares them as CSS custom properties and is the
// single source; this module mirrors the four numbers because the MODE is
// decided in TypeScript — a media query cannot express §15.1's rule
// ("compact if the height is small OR the width is small, wide only when
// BOTH dimensions pass"), and `getComputedStyle` at hook time would be
// neither SSR-safe nor free.
//
// layoutTokens.test.ts parses tokens.css and fails if a number here and a
// number there ever disagree, so "one source" is enforced rather than
// promised.

/** CSS custom property that declares each threshold in styles/tokens.css. */
export const LAYOUT_TOKEN_VARS = {
  compactHeight: "--layout-compact-height",
  compactWidth: "--layout-compact-width",
  wideWidth: "--layout-wide-width",
  wideHeight: "--layout-wide-height",
} as const;

/** The §15.1 thresholds in CSS pixels. */
export const LAYOUT_TOKENS = {
  /** Compact landscape at or below this viewport height (§15.1, §15.3). */
  compactHeight: 520,
  /** Compact portrait below this viewport width. */
  compactWidth: 600,
  /** Wide needs at least this width… */
  wideWidth: 900,
  /** …and at least this height. */
  wideHeight: 600,
} as const satisfies Record<keyof typeof LAYOUT_TOKEN_VARS, number>;
