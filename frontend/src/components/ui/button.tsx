import React from 'react'
import { cn } from '@/lib/utils'

const variantStyles = {
  default: 'bg-accent text-white hover:bg-accent-hover',
  outline: 'border border-border bg-transparent text-text-primary hover:bg-surface-hover',
  ghost: 'bg-transparent text-text-primary hover:bg-surface-hover',
  danger: 'bg-danger text-white hover:bg-red-600',
}

const sizeStyles = {
  sm: 'h-8 px-3 text-xs',
  default: 'h-9 px-4 text-sm',
  lg: 'h-11 px-6 text-base',
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variantStyles
  size?: keyof typeof sizeStyles
}

const Button = ({ className, variant = 'default', size = 'default', ref, ...props }: ButtonProps & { ref?: React.Ref<HTMLButtonElement> }) => {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center rounded-md font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'disabled:pointer-events-none disabled:opacity-50',
        variantStyles[variant],
        sizeStyles[size],
        className,
      )}
      {...props}
    />
  )
}

export { Button }
