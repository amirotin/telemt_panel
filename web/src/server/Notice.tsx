import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { IconCheck, IconInfo, IconWarning } from "../ui/icons";

export type NoticeTone = "ok" | "warn" | "error" | "info";

const TONE_CLASSES: Record<NoticeTone, string> = {
  ok: "border-ok/30 bg-ok/10",
  warn: "border-warn/30 bg-warn/10",
  error: "border-error/30 bg-error/10",
  info: "border-accent/30 bg-accent/10",
};

const TITLE_CLASSES: Record<NoticeTone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  error: "text-error",
  info: "text-accent",
};

const TONE_ICON: Record<NoticeTone, typeof IconCheck> = {
  ok: IconCheck,
  warn: IconWarning,
  error: IconWarning,
  info: IconInfo,
};

export interface NoticeProps {
  tone: NoticeTone;
  title: string;
  children?: ReactNode;
  className?: string;
}

// Notice — the one tinted banner every Сервер outcome renders through
// (config saved / revision conflict / patch rejected / panel restart timed
// out). The prototype uses a soft wash plus a matching hairline for these,
// never a solid slab: they carry an explanation, not an alarm.
export function Notice({ tone, title, children, className }: NoticeProps) {
  const Icon = TONE_ICON[tone];
  return (
    <div
      className={cn("rounded-xl border p-3.5", TONE_CLASSES[tone], className)}
    >
      <div className="flex items-center gap-2">
        <Icon
          aria-hidden="true"
          className={cn("h-4 w-4 shrink-0", TITLE_CLASSES[tone])}
        />
        <p className={cn("text-[13px] font-semibold", TITLE_CLASSES[tone])}>
          {title}
        </p>
      </div>
      {children !== undefined && (
        <div className="mt-2 flex flex-col gap-2">{children}</div>
      )}
    </div>
  );
}
