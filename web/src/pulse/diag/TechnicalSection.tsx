import type { ComponentPropsWithoutRef } from "react";
import { IconChevronDown } from "../../ui/icons";

export function TechnicalSection({ title, description, children, className = "group border-t border-border px-4 py-4 sm:px-5", ...props }: ComponentPropsWithoutRef<"details"> & {
  title: string;
  description?: string;
}) {
  return <details className={className} {...props}>
    <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
      <span>
        <strong className="block text-meta text-text">{title}</strong>
        {description && <span className="block text-micro text-text-muted">{description}</span>}
      </span>
      <IconChevronDown className="shrink-0 transition-transform group-open:rotate-180" />
    </summary>
    {children}
  </details>;
}
