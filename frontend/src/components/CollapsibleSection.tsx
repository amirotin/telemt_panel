import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CollapsibleSectionProps {
  title: string;
  description?: string;
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

export function CollapsibleSection({ title, description, badge, defaultOpen = true, children }: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-3 lg:py-4 px-4 hover:bg-surface-hover transition-colors text-left min-h-[44px]"
      >
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-sm font-medium text-text-primary">{title}</h3>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {badge}
          <ChevronDown size={16} className={cn('text-text-secondary transition-transform shrink-0', open && 'rotate-180')} />
        </div>
      </button>
      {open && (
        <div className="px-4 pb-4">
          {description && (
            <p className="text-xs text-text-secondary mb-3">{description}</p>
          )}
          {children}
        </div>
      )}
    </div>
  );
}
