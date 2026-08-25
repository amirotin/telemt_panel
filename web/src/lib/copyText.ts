export type CopyResult = "clipboard" | "execCommand" | "failed";

// copyText tries the async Clipboard API first (works only in a secure
// context — https, or localhost), then falls back to the classic
// document.execCommand("copy") via a hidden, off-screen textarea — the
// only thing that still works over plain HTTP, which is a primary
// deployment profile for this app (a LAN router's admin panel typically
// has no TLS cert). Never throws — callers (CopyField) branch on the
// returned result instead, showing manual-copy guidance only when both
// mechanisms are unavailable/fail.
export async function copyText(value: string): Promise<CopyResult> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return "clipboard";
    } catch {
      // Fall through to the execCommand fallback below — e.g. permission
      // denied, or a browser that exposes the API but blocks it outside a
      // user gesture in some edge case.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  // Off-screen rather than display:none/hidden — some browsers refuse to
  // select an element that isn't actually rendered.
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.left = "-1000px";
  textarea.setAttribute("readonly", "");
  document.body.appendChild(textarea);
  try {
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    return document.execCommand("copy") ? "execCommand" : "failed";
  } catch {
    return "failed";
  } finally {
    // Always remove the scratch element, including when execCommand
    // throws (e.g. a test/jsdom environment with no real implementation).
    document.body.removeChild(textarea);
  }
}
