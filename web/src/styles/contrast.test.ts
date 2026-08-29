import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SPARKLINE_AREA_ALPHA } from "../ui/Sparkline";

// contrast.test.ts — the palette's WCAG audit, run over the TOKENS rather
// than over a rendered tree. It is the gate for ALL FOUR themes — Тёмная,
// Светлая, «Мокко» and «Пергамент» — plus the prefers-color-scheme mirror
// of Светлая; the two warm palettes were tuned against it, not eyeballed.
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

// The five palette blocks tokens.css defines (four themes plus the
// prefers-color-scheme mirror of «Светлая»), sliced by the landmarks its
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
const systemLight = parsePalette(sliceBlock(":root:not([data-theme])", "\n}\n"));
const mocha = parsePalette(sliceBlock('[data-theme="mocha"] {', "\n}\n"));
const parchment = parsePalette(sliceBlock('[data-theme="parchment"] {', "\n}\n"));

const THEMES: readonly (readonly [string, Palette])[] = [
  ["dark", dark],
  ["light", light],
  ["mocha", mocha],
  ["parchment", parchment],
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

describe("tokens.css parses into four complete palettes", () => {
  it("finds every token this audit needs in every theme", () => {
    for (const [name, p] of THEMES) {
      expect(Object.keys(p).length, name).toBeGreaterThan(20);
      for (const key of [...SURFACES, ...TONES, ...NEUTRAL_TEXT]) {
        expect(p[key], `${name} --${key}`).toBeDefined();
      }
    }
  });

  // The mirror: a theme that defines only SOME of the roles inherits the
  // rest from :root, which is the dark palette — so «Пергамент» missing one
  // token would paint a single slate-blue element into a cream page, and
  // nothing else would notice. Every theme block must therefore carry
  // exactly the same token NAMES as the dark default; the values are what
  // differ. (parsePalette only sees RGB triplets, so the font stacks and
  // the theme-independent layout lengths never enter this comparison.)
  const expected = Object.keys(dark).sort();

  it.each([
    ["light", light],
    ["mocha", mocha],
    ["parchment", parchment],
  ] as const)("gives %s a value for every token the dark default defines", (_name, p) => {
    expect(Object.keys(p).sort()).toEqual(expected);
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

// WCAG 1.4.11: a solid fill IS the boundary of the component it paints, so
// it needs 3:1 against whatever it sits on — a separate measurement from
// "the label reads on the fill" above, and the one the warm palettes fell
// through. «Мокко» shipped an --error-strong that was 2.01:1 against
// --surface-2 (a badge with no visible edge) and a switch knob at 2.51:1
// against its own amber track.
//
// Grounds, per fill:
//   * accent-strong / error-strong / focus-ring — the three page surfaces;
//   * control-knob — --accent-strong, the track it rides in the ON state;
//   * the three bar steps — --bar-track.
//
// NOT covered, and deliberately: the knob against --surface-3, the OFF
// track. A white knob on a light grey track is 1.31:1 in Светлая and
// 1.45:1 in «Пергамент» — the same in every light palette, predating this
// task. The control is read there from the knob's POSITION plus its
// shadow, and forcing the pair apart would mean repainting Светлая, which
// this palette work is explicitly not doing. Recorded as a number rather
// than left unmeasured.
describe.each(THEMES)("solid fills keep their own boundary (%s)", (name, p) => {
  for (const fill of ["accent-strong", "error-strong", "focus-ring"] as const) {
    for (const surface of SURFACES) {
      it(`--${fill} against --${surface}`, () => {
        expect(
          contrast(token(p, fill), token(p, surface)),
          `${name}: --${fill} on --${surface}`,
        ).toBeGreaterThanOrEqual(NON_TEXT);
      });
    }
  }

  it("--control-knob against the accent track it rides", () => {
    expect(
      contrast(token(p, "control-knob"), token(p, "accent-strong")),
      `${name}: --control-knob on --accent-strong`,
    ).toBeGreaterThanOrEqual(NON_TEXT);
  });

  for (const step of ["bar-fill", "bar-fill-warn", "bar-fill-full"] as const) {
    it(`--${step} against --bar-track`, () => {
      expect(
        contrast(token(p, step), token(p, "bar-track")),
        `${name}: --${step} on --bar-track`,
      ).toBeGreaterThanOrEqual(NON_TEXT);
    });
  }
});

// CIE76 ΔE — a crude perceptual distance, but the right KIND of measure
// here: the quota bar's three steps differ from each other by colour alone
// (ui/quota.helpers.ts), with no word on the fill, so a luminance ratio
// between them says nothing useful. «Пергамент» is why the floor exists:
// its accent and its warn are 16.6 apart and the 80 % step was the same
// stripe as the one below it.
function lab([r, g, b]: Rgb): readonly [number, number, number] {
  const R = channel(r);
  const G = channel(g);
  const B = channel(b);
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function deltaE(a: Rgb, b: Rgb): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** Well under every theme's real separation, well over the 16.6 that failed. */
const BAR_STEP_DELTA_E = 25;

describe.each(THEMES)("the quota bar's three steps stay apart (%s)", (name, p) => {
  const STEPS = ["bar-fill", "bar-fill-warn", "bar-fill-full"] as const;
  for (let i = 0; i < STEPS.length; i++) {
    for (let j = i + 1; j < STEPS.length; j++) {
      it(`--${STEPS[i]} vs --${STEPS[j]}`, () => {
        expect(
          deltaE(token(p, STEPS[i]!), token(p, STEPS[j]!)),
          `${name}: ΔE --${STEPS[i]} vs --${STEPS[j]}`,
        ).toBeGreaterThanOrEqual(BAR_STEP_DELTA_E);
      });
    }
  }
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

// Сводка's Показатели tiles paint their sparkline as the tile's own
// background (`Sparkline area`), with the label, the 30px value and the
// caption on top of it. The worst pixel is the whole fill: it is a flat
// `tone@SPARKLINE_AREA_ALPHA` over the card's `--surface`, so the darkest
// (dark themes) / lightest (light themes) area pixel is exactly what this
// composites. The alpha is imported rather than repeated — raising it in
// Sparkline.tsx fails here instead of quietly dimming the caption.
describe.each(THEMES)("Показатели tiles keep their text over the area chart (%s)", (name, p) => {
  for (const tone of TONES) {
    for (const role of ["text", "text-muted"] as const) {
      const label = `text-${role} over ${tone}@${SPARKLINE_AREA_ALPHA} over --surface`;
      it(`${label} clears AA`, () => {
        const behind = composite(token(p, tone), SPARKLINE_AREA_ALPHA, token(p, "surface"));
        expect(contrast(token(p, role), behind), `${name}: ${label}`).toBeGreaterThanOrEqual(AA);
      });
    }
  }
});
