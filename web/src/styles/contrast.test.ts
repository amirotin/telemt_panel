import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

// contrast.test.ts — the palette's WCAG audit, run over the TOKENS rather
// than over a rendered tree.
//
// The reason it parses tokens.css instead of walking the DOM: a probe that
// asks the browser for an element's `background-color` walks UP the tree
// until it finds an opaque one, so it never sees the translucent layer the
// text is actually painted on. The app's single most common status
// affordance is exactly such a layer — `StatePill` is `bg-<tone>/15
// text-<tone>` (ui/StatePill.tsx), which Tailwind v4 compiles to a 15 %-alpha
// `color-mix`, so the pill's text sits on `tone@15 % over <surface>`, not on
// `<surface>`. Measured the wrong way the light-theme `ok` pill reads 4.92:1;
// composited it reads 4.03:1. Every ratio below composites first.
//
// Scope — the pairs the app really paints, and only those:
//
//   * tone TEXT on a plain surface (`text-ok` in a card, an icon label);
//   * tone text on its OWN tint, at every alpha the codebase uses in a
//     resting state (0.08–0.15): StatePill and CountBadge's warn tone at
//     /15, StatRow/DcWidget/ServerMenu/Toast at /10–/14, Button danger and
//     ErrorState at /8–/12;
//   * the neutral text roles (`--text`, `--text-muted`, `--text-faint`) on
//     the same surfaces;
//   * white on the two solid *-strong fills CountBadge and Button use.
//
// Surfaces are the three a page actually paints these on: `--bg` (the page
// itself and every Details header), `--surface` (a card) and `--surface-2`
// (a sunken row, the darkest/lightest of the three and therefore the worst
// case for a tint of the same hue).
//
// RULING — transient hover/active fills are held to 3:1, not 4.5:1.
// `Button`'s danger tone deepens to `bg-error/20` on hover and `/25` on
// press, and `LogToolbar`'s selected chip to `bg-accent/25`; because the
// tint IS the text's own hue, deepening it always costs contrast. Their
// RESTING presentations (/12 and /15) clear AA below, the momentary states
// clear 3:1, and pushing the tokens far enough for /25 to clear 4.5:1 would
// wash the palette out to pastel. This is a decision, not a measurement —
// stated here so it cannot be mistaken for one.
//
// Not covered, deliberately: `brand-gradient` (login mark, Shell logo) is a
// gradient, not a token pair, and is decorative text over a fixed artwork.

const TOKENS = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "tokens.css"),
  "utf8",
);

type Rgb = readonly [number, number, number];
type Palette = Record<string, Rgb>;

function parsePalette(text: string): Palette {
  const out: Record<string, Rgb> = {};
  for (const m of text.matchAll(/--([a-z0-9-]+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g)) {
    out[m[1]!] = [Number(m[2]), Number(m[3]), Number(m[4])];
  }
  return out;
}

// The three palette blocks tokens.css defines, sliced by the landmarks its
// own comments provide. Failing loudly here beats silently auditing {}.
function sliceBlock(startMarker: string, endMarker: string): string {
  const start = TOKENS.indexOf(startMarker);
  const end = TOKENS.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`tokens.css structure changed: ${startMarker} .. ${endMarker}`);
  }
  return TOKENS.slice(start, end);
}

const dark = parsePalette(sliceBlock(":root {", "\n * Layout model"));
const light = parsePalette(sliceBlock('[data-theme="light"] {', "/* Only reached"));
const systemLight = parsePalette(sliceBlock(':root:not([data-theme="dark"])', "\n}\n"));

const THEMES: readonly (readonly [string, Palette])[] = [
  ["dark", dark],
  ["light", light],
];

const SURFACES = ["bg", "surface", "surface-2"] as const;

/** Alphas the codebase paints tone text on, in a RESTING state. */
const RESTING_ALPHAS = [0, 0.08, 0.1, 0.12, 0.14, 0.15] as const;
/** Hover/active-only deepenings — see the ruling above. */
const TRANSIENT: readonly (readonly [string, number])[] = [
  ["error", 0.2],
  ["error", 0.25],
  ["accent", 0.25],
];

const TONES = ["ok", "warn", "error", "muted", "accent"] as const;
const NEUTRAL_TEXT = ["text", "text-muted", "text-faint"] as const;

const AA = 4.5;
const NON_TEXT = 3;

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// composite is what the probe was missing: `bg-<tone>/<pct>` is the tone at
// that alpha over whatever is behind it, blended in sRGB — the space the
// browser composites in, and the space the ratios below must be read in.
function composite(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [
    alpha * fg[0] + (1 - alpha) * bg[0],
    alpha * fg[1] + (1 - alpha) * bg[1],
    alpha * fg[2] + (1 - alpha) * bg[2],
  ];
}

function token(p: Palette, name: string): Rgb {
  const v = p[name];
  if (v === undefined) throw new Error(`token --${name} is missing from tokens.css`);
  return v;
}

describe("tokens.css parses into three complete palettes", () => {
  it("finds every token this audit needs in both themes", () => {
    for (const [name, p] of THEMES) {
      expect(Object.keys(p).length, name).toBeGreaterThan(20);
      for (const key of [...SURFACES, ...TONES, ...NEUTRAL_TEXT]) {
        expect(p[key], `${name} --${key}`).toBeDefined();
      }
    }
  });

  // tokens.css's own comment promises the prefers-color-scheme block is
  // "kept in sync field-for-field" with [data-theme="light"]. An audit of
  // only one of them would leave the «Системная» setting unmeasured.
  it("keeps the system-light block identical to [data-theme=light]", () => {
    expect(Object.keys(systemLight).sort()).toEqual(Object.keys(light).sort());
    for (const key of Object.keys(light)) {
      expect(systemLight[key], `--${key}`).toEqual(light[key]);
    }
  });
});

describe.each(THEMES)("StatePill and tone text composite to AA (%s)", (name, p) => {
  for (const tone of TONES) {
    for (const surface of SURFACES) {
      for (const alpha of RESTING_ALPHAS) {
        const label =
          alpha === 0
            ? `text-${tone} on --${surface}`
            : `bg-${tone}/${alpha * 100} text-${tone} over --${surface}`;
        it(`${label} clears AA`, () => {
          const fg = token(p, tone);
          const bg = token(p, surface);
          const behind = alpha === 0 ? bg : composite(fg, alpha, bg);
          expect(contrast(fg, behind), `${name}: ${label}`).toBeGreaterThanOrEqual(AA);
        });
      }
    }
  }
});

describe.each(THEMES)("neutral text roles clear AA on every surface (%s)", (name, p) => {
  for (const role of NEUTRAL_TEXT) {
    for (const surface of SURFACES) {
      it(`text-${role} on --${surface}`, () => {
        expect(
          contrast(token(p, role), token(p, surface)),
          `${name}: --${role} on --${surface}`,
        ).toBeGreaterThanOrEqual(AA);
      });
    }
  }
});

describe.each(THEMES)("solid fills carry their white label (%s)", (name, p) => {
  // CountBadge's accent/error tones and Button's primary: `text-accent-text`
  // (white) on a *-strong fill. The text-weight `--accent` is NOT a fill —
  // white on it is 2.6:1 dark — which is the whole reason the strong tokens
  // exist.
  for (const [label, fill] of [
    ["accent-text", "accent-strong"],
    ["error-text", "error-strong"],
  ] as const) {
    it(`--${label} on --${fill}`, () => {
      expect(
        contrast(token(p, label), token(p, fill)),
        `${name}: --${label} on --${fill}`,
      ).toBeGreaterThanOrEqual(AA);
    });
  }

  it("keeps CountBadge's muted tone readable on its own sunken fill", () => {
    expect(
      contrast(token(p, "text-muted"), token(p, "surface-2")),
      `${name}: --text-muted on --surface-2`,
    ).toBeGreaterThanOrEqual(AA);
  });
});

describe.each(THEMES)("transient hover/active tints clear 3:1 (%s)", (name, p) => {
  for (const [tone, alpha] of TRANSIENT) {
    for (const surface of SURFACES) {
      it(`bg-${tone}/${alpha * 100} text-${tone} over --${surface}`, () => {
        const fg = token(p, tone);
        const ratio = contrast(fg, composite(fg, alpha, token(p, surface)));
        // Not AA by ruling (see the header): a hover/active deepening of a
        // tint made of the text's own hue cannot reach 4.5:1 without
        // pastelling the token, and the resting state above already does.
        expect(ratio, `${name}: ${tone}@${alpha} over --${surface}`).toBeGreaterThanOrEqual(
          NON_TEXT,
        );
      });
    }
  }
});
