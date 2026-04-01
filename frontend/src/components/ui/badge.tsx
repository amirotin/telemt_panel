import React from 'react'
import { cn } from '@/lib/utils'

const variantStyles = {
  default: 'bg-accent/20 text-accent border-accent/30',
  success: 'bg-success/20 text-success border-success/30',
  warning: 'bg-warning/20 text-warning border-warning/30',
  danger: 'bg-danger/20 text-danger border-danger/30',
  outline: 'bg-transparent text-text-secondary border-border',
}

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: keyof typeof variantStyles
}

const Badge = ({ className, variant = 'default', ref, ...props }: BadgeProps & { ref?: React.Ref<HTMLSpanElement> }) => {
  return (
    <span
      ref={ref}
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium transition-colors',
        variantStyles[variant],
        className,
      )}
      {...props}
    />
  )
}

export { Badge }
