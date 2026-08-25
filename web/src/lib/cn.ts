// Minimal classnames joiner — falsy values dropped, no dependency pulled
// in just for this (clsx/tailwind-merge would be one more thing to justify
// per the plan's dependency budget).
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
