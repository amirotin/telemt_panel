import { StatusBadge } from '@/components/StatusBadge';
import { CollapsibleSection } from '@/components/CollapsibleSection';

interface MERuntimeSectionProps {
  data: Record<string, unknown> | null;
}

export function MERuntimeSection({ data }: MERuntimeSectionProps) {
  if (!data || Object.keys(data).length === 0) return null;

  return (
    <CollapsibleSection title="ME Runtime" defaultOpen={false}>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {Object.entries(data).map(([key, value]) => {
          if (value == null || typeof value === 'object') return null;
          const label = key.replace(/_/g, ' ');
          if (typeof value === 'boolean') {
            return (
              <div key={key} className="min-w-0 flex items-center justify-between gap-2 bg-background rounded p-2 border border-border/50 text-xs">
                <span className="text-text-secondary truncate">{label}</span>
                <StatusBadge status={value} />
              </div>
            );
          }
          let display = String(value);
          if (typeof value === 'number') {
            display = key.includes('_secs') ? `${value}s` : key.includes('_ms') ? `${value}ms` : String(value);
          }
          return (
            <div key={key} className="min-w-0 bg-background rounded p-2 border border-border/50 text-xs">
              <div className="text-text-secondary truncate">{label}</div>
              <div className="text-text-primary font-medium">{display}</div>
            </div>
          );
        })}
      </div>
    </CollapsibleSection>
  );
}
