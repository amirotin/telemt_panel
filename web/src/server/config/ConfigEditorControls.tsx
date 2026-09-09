import { type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Toggle } from "../../ui/Toggle";
import { IconPlus } from "../../ui/icons";

export function RouteChoice({ active, title, hint, onClick }: { active: boolean; title: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      className={cn(
        "min-h-[68px] rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
        active ? "border-accent/40 bg-surface shadow-sm" : "border-transparent text-text-muted hover:bg-surface/60",
      )}
      onClick={onClick}
    >
      <span className="flex items-center gap-2">
        <span className={cn("size-2 rounded-full", active ? "bg-ok" : "bg-text-faint/40")} />
        <strong className="text-sm text-text">{title}</strong>
      </span>
      <span className="mt-1 block pl-4 text-meta leading-snug text-text-muted">{hint}</span>
    </button>
  );
}

export function RoutingToggleRow({ label, hint, checked, disabled = false, onChange }: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className={cn("flex min-h-[72px] w-full min-w-0 items-center gap-4 py-3", disabled && "opacity-65")}>
      <div className="min-w-0 flex-1">
        <strong className="text-sm font-semibold text-text">{label}</strong>
        <p className="mt-1 text-meta leading-snug text-text-muted">{hint}</p>
      </div>
      <Toggle checked={checked} disabled={disabled} onChange={onChange} aria-label={label} />
    </div>
  );
}

export function SectionHeading({ title, hint, restart }: { title: string; hint: string; restart?: string }) {
  return (
    <div className="mb-3 flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:justify-between sm:gap-3">
      <div className="min-w-0">
        <h3 className="text-sm font-bold text-text">{title}</h3>
        <p className="mt-1 text-meta leading-relaxed text-text-muted">{hint}</p>
      </div>
      {restart && <span className="shrink-0 rounded-full bg-warn/10 px-2 py-1 text-micro font-bold text-warn">{restart}</span>}
    </div>
  );
}

export function Subsection({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="mt-7 border-t border-border pt-4">
      <header className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-bold text-text">{title}</h3>
        <span className="rounded-full bg-surface-2 px-2 py-1 text-micro font-semibold text-text-faint">{count}</span>
      </header>
      {children}
    </section>
  );
}

export function AddRecordButton({ children, disabled, onClick }: { children: ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border-strong text-meta font-semibold text-accent hover:bg-accent/[0.05] disabled:cursor-not-allowed disabled:opacity-40"
      onClick={onClick}
    >
      <IconPlus className="size-4" />
      {children}
    </button>
  );
}

export function RecordListEmpty({ show, children }: { show: boolean; children: ReactNode }) {
  return show ? <p className="border-y border-border py-5 text-center text-meta text-text-muted">{children}</p> : null;
}

export function RecordIconButton({ label, danger = false, disabled = false, onClick, children }: { label: string; danger?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn("grid size-11 shrink-0 place-items-center rounded-lg text-text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-30", danger && "hover:bg-bad/10 hover:text-bad")}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
