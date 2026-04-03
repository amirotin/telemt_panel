import { StatusBadge } from '@/components/StatusBadge';

interface GatesSectionProps {
  gates: Record<string, unknown> | null;
}

export function GatesSection({ gates }: GatesSectionProps) {
  if (!gates) return null;

  // Filter out startup fields (they're shown on Dashboard)
  const filtered = Object.fromEntries(
    Object.entries(gates).filter(([key]) =>
      !key.startsWith('startup_')
    )
  );

  if (Object.keys(filtered).length === 0) return null;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {Object.entries(filtered).map(([key, value]) => (
        <div key={key} className="bg-surface border border-border rounded-lg p-3 min-h-[44px] flex flex-col items-center justify-center gap-2">
          <span className="text-xs text-text-secondary text-center leading-tight">{key.replace(/_/g, ' ')}</span>
          {typeof value === 'boolean' ? (
            <StatusBadge status={value} />
          ) : (
            <span className="text-sm text-text-primary font-medium">{String(value)}</span>
          )}
        </div>
      ))}
    </div>
  );
}
