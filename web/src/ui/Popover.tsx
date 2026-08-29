import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { Button } from "./Button";
import { IconChevronDown } from "./icons";

export interface PopoverProps {
  /** The trigger's visible label, and the panel's accessible name. */
  label: string;
  /** Leading glyph on the trigger. */
  icon?: ReactNode;
  /**
   * Panel body. Any <button> inside it dismisses the popover once its own
   * handler has run — every control in a menu of this shape is a choice, and
   * a menu that stays open after one has been made is a menu the reader has
   * to close by hand.
   */
  children: ReactNode;
  /** Which edge of the trigger the panel aligns to. Default "end" (the right edge in LTR). */
  align?: "start" | "end";
  className?: string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Popover — a small panel anchored to its own trigger, for a handful of
// settings that belong to one screen. Sheet is the app's dialog primitive
// and stays that: a modal that dims the page and traps focus is the wrong
// weight for «три радиокнопки и две ссылки», and on a desktop it throws the
// reader to the middle of the screen and back.
//
// None of this project's approved dependencies ships a popover (see
// web/README.md), so the behaviour is here, once: `aria-haspopup="dialog"` +
// `aria-expanded` on the trigger, focus moved into the panel on open and
// returned to the trigger on Escape or on an action, Escape and an outside
// click both dismiss. Focus is deliberately NOT yanked back on an outside
// click — the reader is already somewhere else by then.
export function Popover({ label, icon, children, align = "end", className }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const dismiss = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    (panel?.querySelector<HTMLElement>(FOCUSABLE) ?? panel)?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      dismiss(true);
    }
    function onPointerDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) dismiss(false);
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open, dismiss]);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <Button
        variant="ghost"
        size="sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => {
          // The trigger is whatever was clicked — captured here rather than
          // through a forwarded ref, so Popover keeps using the Button
          // primitive instead of re-implementing its look.
          triggerRef.current = e.currentTarget;
          setOpen((v) => !v);
        }}
      >
        {icon}
        {label}
        <IconChevronDown className="h-3.5 w-3.5 opacity-70" />
      </Button>
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label={label}
          tabIndex={-1}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("button")) dismiss(true);
          }}
          className={cn(
            "absolute top-full z-40 mt-1.5 w-[min(21rem,calc(100vw-2rem))] rounded-xl",
            "border border-border bg-surface p-3 shadow-2xl outline-none",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}
