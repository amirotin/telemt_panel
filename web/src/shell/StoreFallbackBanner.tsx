import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { fill, useStrings } from "../i18n";
import { getHealthOptions } from "../lib/api/generated/@tanstack/react-query.gen";
import { IconWarning } from "../ui/icons";

export function StoreFallbackBanner() {
  const s = useStrings();
  const health = useQuery({
    ...getHealthOptions(),
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: false,
  });
  const status = health.data;
  if (!status?.store_error || status.active_driver !== "memory") return null;

  const driver = status.configured_driver === "postgres" ? "PostgreSQL" : "MySQL";
  return (
    <aside
      role="status"
      className="mb-3 flex shrink-0 items-start gap-2.5 rounded-xl border border-warning/30 bg-warning/8 px-3 py-2.5 text-[11px] sm:items-center sm:px-4"
      data-testid="store-fallback-banner"
    >
      <IconWarning className="mt-0.5 h-4 w-4 shrink-0 text-warning-text sm:mt-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 leading-relaxed">
        <strong className="mr-1.5 font-bold text-text">{s.shell.storageFallbackTitle}</strong>
        <span className="text-text-muted">
          {fill(s.shell.storageFallbackBody, { driver })}
        </span>
      </div>
      <Link
        to="/server/settings"
        className="tap-target -my-2 hidden shrink-0 items-center font-bold text-warning-text hover:underline sm:flex"
      >
        {s.shell.storageFallbackAction}
      </Link>
    </aside>
  );
}
