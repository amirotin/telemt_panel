import { useSyncExternalStore } from "react";
import { cn } from "../lib/cn";

export type ToastVariant = "default" | "ok" | "error";

export interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

// Module-level store (useSyncExternalStore, not a state library — see
// 06-ui.md's ruling against adding zustand): a plain external store is
// enough for a FIFO toast queue, and it means push() works from anywhere
// (event handlers, query error callbacks) without needing a hook's
// component context.
let toasts: ToastItem[] = [];
let nextId = 1;
const subscribers = new Set<() => void>();

function notify() {
  for (const sub of subscribers) sub();
}

function subscribe(cb: () => void) {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

function getSnapshot() {
  return toasts;
}

const DEFAULT_DURATION_MS = 4000;

export function pushToast(message: string, variant: ToastVariant = "default", durationMs = DEFAULT_DURATION_MS) {
  const id = nextId++;
  toasts = [...toasts, { id, message, variant }];
  notify();
  setTimeout(() => dismissToast(id), durationMs);
  return id;
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  notify();
}

const variantClasses: Record<ToastVariant, string> = {
  default: "border-border bg-surface-2 text-text",
  ok: "border-ok/40 bg-ok/10 text-ok",
  error: "border-error/40 bg-error/10 text-error",
};

// ToastViewport renders the live queue — mount once near the app root.
// Positioned above the mobile tab bar + safe area (Task 4 wires the tab
// bar height in; this component only needs its own safe-area margin).
export function ToastViewport() {
  const items = useSyncExternalStore(subscribe, getSnapshot);

  if (items.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 px-4 pb-safe pb-4"
      role="status"
      aria-live="polite"
    >
      {items.map((t) => (
        <div
          key={t.id}
          className={cn(
            "pointer-events-auto w-full max-w-sm rounded-xl border px-4 py-3 text-[13px] font-medium shadow-xl",
            variantClasses[t.variant],
          )}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
