// prefersReducedMotion — the SCRIPTED half of spec §21's reduced-motion
// rule. styles/index.css neutralises CSS animations and transitions under
// `prefers-reduced-motion: reduce`, but a scripted scroll
// (`scrollIntoView({ behavior: "smooth" })`) is not a CSS animation and
// ignores that rule entirely, so every call site that asks for smooth
// motion in JS asks here first.
//
// Deliberately read on every call rather than cached: the preference can
// change while the tab is open (a11y settings, a display switch), and this
// costs one matchMedia lookup on a user gesture, never in a render loop.
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The `behavior` to pass to scrollIntoView / scrollTo for optional motion. */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}
