import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";
import { useStrings } from "../i18n";
import { IconButton } from "./IconButton";
import { IconClose } from "./icons";

/**
 * Where the panel is anchored. "auto" is the app default — a bottom sheet
 * on a phone, a centered modal from `lg:` up. The other three pin one
 * shape: spec §17 asks a details surface to be a bottom sheet in phone
 * PORTRAIT, a side sheet in phone LANDSCAPE and a centered modal on
 * desktop, and landscape-vs-portrait is a decision about available height
 * that a width-only media query cannot make.
 */
export type SheetPlacement = "auto" | "bottom" | "side" | "modal" | "form";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** Optional compact label above the title (used by full task forms). */
  eyebrow?: string;
  /** Secondary line under the title — status, identity context. */
  subtitle?: ReactNode;
  placement?: SheetPlacement;
  children: ReactNode;
  className?: string;
  headerClassName?: string;
  bodyClassName?: string;
}

const CONTAINER_CLASSES: Record<SheetPlacement, string> = {
  auto: "flex items-end justify-center lg:items-center",
  bottom: "flex items-end justify-center",
  side: "flex items-stretch justify-end",
  modal: "flex items-center justify-center",
  form: "flex items-stretch justify-center lg:items-center",
};

const PANEL_CLASSES: Record<SheetPlacement, string> = {
  auto: "max-h-[85dvh] w-full rounded-t-3xl pb-safe lg:max-w-lg lg:rounded-3xl lg:pb-0",
  bottom: "max-h-[85dvh] w-full rounded-t-3xl pb-safe",
  // Never taller than the viewport (§15.3: "surface не должен превышать
  // доступную высоту") — the body scrolls inside instead.
  side: "h-dvh max-h-dvh w-full max-w-sm rounded-l-3xl pb-safe",
  modal: "m-4 max-h-[85dvh] w-full max-w-lg rounded-3xl",
  form: "h-dvh max-h-dvh w-full rounded-none pb-safe lg:h-auto lg:max-h-[90dvh] lg:max-w-[680px] lg:rounded-2xl lg:pb-0",
};

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Sheet is the single dialog primitive: a bottom sheet on mobile, a
// centered modal from `lg:` up — one implementation, not two components
// that drift apart (06-ui.md). max-h-[85dvh] + internal scroll so it works
// with the on-screen keyboard open; safe-area padding on the bottom edge;
// a minimal focus trap + Escape-to-close, since none of this project's
// approved dependencies (see web/README.md) include a dialog primitive.
export function Sheet({
  open,
  onClose,
  title,
  eyebrow,
  subtitle,
  placement = "auto",
  children,
  className,
  headerClassName,
  bodyClassName,
}: SheetProps) {
  const s = useStrings();
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const firstFocusable = panel?.querySelector<HTMLElement>(FOCUSABLE);
    firstFocusable?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className={cn("fixed inset-0 z-50", CONTAINER_CLASSES[placement])}>
      <div
        className="absolute inset-0 bg-scrim/60"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "relative flex flex-col overflow-hidden bg-surface shadow-2xl",
          PANEL_CLASSES[placement],
          className,
        )}
      >
        {/* Grabber — the prototype's bottom-sheet affordance; purely
            decorative (the sheet is dismissed by the backdrop, Escape or
            the close button), so it is hidden from the a11y tree and from
            the centered `lg:` modal. */}
        {(placement === "auto" || placement === "bottom") && (
          <div
            className={cn(
              "mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-muted/40",
              placement === "auto" && "lg:hidden",
            )}
            aria-hidden="true"
          />
        )}
        <div className={cn("flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3", headerClassName)}>
          <div className="min-w-0">
            {eyebrow && <span data-sheet-eyebrow>{eyebrow}</span>}
            <h2 className="break-words text-[15px] font-bold text-text">{title}</h2>
            {subtitle !== undefined && subtitle !== "" && (
              <p className="mt-0.5 break-words text-meta text-text-muted">{subtitle}</p>
            )}
          </div>
          <IconButton aria-label={s.common.close} onClick={onClose}>
            <IconClose />
          </IconButton>
        </div>
        <div className={cn("min-h-0 flex-1 overflow-y-auto px-4 py-3", bodyClassName)}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}
