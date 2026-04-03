import { cn } from '@/lib/utils';

export interface StatusDotProps {
  status: 'ok' | 'warn' | 'error';
  size?: 'sm' | 'md';
  animated?: boolean;
  className?: string;
}

const sizeMap = { sm: 'h-2 w-2', md: 'h-3 w-3' } as const;

const colorMap = {
  ok: 'bg-status-ok',
  warn: 'bg-status-warn',
  error: 'bg-status-error',
} as const;

export function StatusDot({ status, size = 'sm', animated = false, className }: StatusDotProps) {
  return (
    <span
      className={cn(
        'inline-block rounded-full shrink-0',
        sizeMap[size],
        colorMap[status],
        animated && 'animate-breathe',
        className,
      )}
      role="img"
      aria-label={`Status: ${status}`}
    />
  );
}
