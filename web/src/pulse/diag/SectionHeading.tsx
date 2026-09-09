export function SectionHeading({ kicker, title, meta }: { kicker: string; title: string; meta?: string }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div>
        <span className="text-label font-semibold uppercase tracking-[0.12em] text-text-muted">
          {kicker}
        </span>
        <h3 className="mt-1 text-h3 font-semibold text-text">{title}</h3>
      </div>
      {meta && <span className="text-micro text-text-muted">{meta}</span>}
    </header>
  );
}
