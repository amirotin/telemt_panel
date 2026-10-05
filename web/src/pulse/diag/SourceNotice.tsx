import type { ComponentPropsWithoutRef } from "react";

export function SourceNotice({ title, description, children, level = 2, className = "px-4 py-6 sm:px-5", panelClassName = "rounded-2xl border border-dashed border-border px-5 py-10 text-center", ...props }: ComponentPropsWithoutRef<"section"> & {
  title: string;
  description: string;
  level?: 2 | 3;
  panelClassName?: string;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return <section className={className} {...props}>
    <div className={panelClassName}>
      <Heading className="text-h2 font-semibold text-text">{title}</Heading>
      <p className="mx-auto mt-2 max-w-prose text-meta text-text-muted">{description}</p>
      {children}
    </div>
  </section>;
}
