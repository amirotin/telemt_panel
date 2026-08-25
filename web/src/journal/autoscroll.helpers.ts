// AUTOSCROLL_THRESHOLD_PX — how close to the bottom edge a scroll position
// still counts as "at the bottom" for autoscroll purposes (Task 7 brief A:
// "автоскролл к последним строкам, если пользователь у низа"). A small
// slop accounts for sub-pixel rounding and momentum scrolling on mobile,
// not a deliberate "near the bottom is good enough" UX choice.
export const AUTOSCROLL_THRESHOLD_PX = 48;

// isScrolledToBottom — the one predicate LogList uses both to decide
// whether to autoscroll a freshly-appended line and to decide whether the
// floating "к новым" button should show while the user has scrolled up.
export function isScrolledToBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  thresholdPx: number = AUTOSCROLL_THRESHOLD_PX,
): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= thresholdPx;
}
