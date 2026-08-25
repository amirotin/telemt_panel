import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export interface SectionLabelProps {
  children: ReactNode;
  className?: string;
}

// SectionLabel — the uppercase caption the prototype sets above every block
// ("АКТИВНЫЕ IP", "ПОЛЯ — КЛИК ДОБАВЛЯЕТ ФИЛЬТР", "ИСТОРИЯ ОБНОВЛЕНИЙ").
// Lives in ui/ because Люди, Пульс, Журнал and Сервер all caption blocks
// the same way; people/PersonSections re-exports it for its own callers.
export function SectionLabel({ children, className }: SectionLabelProps) {
  return (
    <h2
      className={cn(
        "text-micro font-semibold uppercase tracking-[0.06em] text-text-faint",
        className,
      )}
    >
      {children}
    </h2>
  );
}
