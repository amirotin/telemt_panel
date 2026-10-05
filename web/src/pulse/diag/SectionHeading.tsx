export function SectionHeading({ kicker, title, meta, description, level = 3, variant = "compact" }: {
  kicker: string;
  title: string;
  meta?: string;
  description?: string;
  level?: 2 | 3;
  variant?: "standard" | "compact";
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div>
        <span className="text-label font-semibold uppercase tracking-[0.12em] text-text-muted">
          {kicker}
        </span>
        <Heading className={`mt-1 ${variant === "standard" ? "text-h2" : "text-h3"} font-semibold text-text`}>{title}</Heading>
        {description && <p className="mt-2 max-w-prose text-meta text-text-muted">{description}</p>}
      </div>
      {meta && <span className="text-micro text-text-muted">{meta}</span>}
    </header>
  );
}
