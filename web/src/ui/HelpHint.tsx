import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { isFocusVisible, useFocus, useHover, usePress } from "@react-aria/interactions";
import { mergeProps } from "@react-aria/utils";

/** Read-only help, shared by metrics and form labels; touch never depends on hover. */
export function HelpHint({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const readingPress = useRef(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const open = !dismissed && (hovered || focused || pinned);
  const { hoverProps } = useHover({
    onHoverStart: () => {
      clearTimeout(hoverTimer.current);
      setHovered(true);
      setDismissed(false);
    },
    // Allows crossing the small gap into the help text without losing it.
    onHoverEnd: () => { hoverTimer.current = setTimeout(() => setHovered(false), 120); },
  });
  const { focusProps } = useFocus({
    onFocus: () => { if (isFocusVisible()) { setFocused(true); setDismissed(false); } },
    onBlur: (event) => {
      setFocused(false);
      // Tapping non-focusable help text blurs the trigger on touch browsers.
      // Keep the pinned explanation readable, but never keep it on Tab away.
      if (event.relatedTarget !== null || !readingPress.current) setPinned(false);
    },
  });
  const { pressProps } = usePress({
    onPress: () => { setPinned(!pinned); setDismissed(pinned); },
  });
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !tip.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      tip.current.style.maxWidth = `${Math.max(0, width - 24)}px`;
      tip.current.style.maxHeight = `${Math.max(0, height - 24)}px`;
      const box = tip.current.getBoundingClientRect();
      tip.current.style.left = `${Math.max(left + 12, Math.min(anchor.right - box.width, left + width - box.width - 12))}px`;
      tip.current.style.top = `${Math.max(top + 12, anchor.bottom + box.height + 8 <= top + height - 12 ? anchor.bottom + 8 : anchor.top - box.height - 8)}px`;
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    if (tip.current) observer?.observe(tip.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    const dismiss = () => { setPinned(false); setDismissed(true); };
    const outside = (event: PointerEvent) => {
      readingPress.current = event.target instanceof Node && !!tip.current?.contains(event.target);
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !tip.current?.contains(event.target)) dismiss();
    };
    const escape = (event: KeyboardEvent) => { readingPress.current = false; if (event.key === "Escape" || event.key === "Tab") dismiss(); };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return <>
    <button {...mergeProps(hoverProps, focusProps, pressProps)} ref={trigger} type="button" aria-label={label} aria-expanded={open} aria-describedby={open ? id : undefined}
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-2 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
      <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <circle cx="10" cy="10" r="7.5" /><path d="M7.8 7.4a2.2 2.2 0 0 1 4.4 0c0 1.7-2.2 1.7-2.2 3.2" /><path d="M10 13.2v.1" strokeLinecap="round" />
      </svg>
    </button>
    {open && createPortal(<div {...hoverProps} ref={tip} id={id} role="tooltip"
      className="fixed z-[80] w-[340px] overflow-y-auto rounded-xl border border-border bg-surface px-4 py-3 text-meta leading-relaxed text-text shadow-xl">{children}</div>, document.body)}
  </>;
}
