import React from 'react'
import { cn } from '@/lib/utils'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = ({ className, type, ref, ...props }: InputProps & { ref?: React.Ref<HTMLInputElement> }) => {
  return (
    <input
      type={type}
      ref={ref}
      className={cn(
        'flex h-9 w-full rounded-md border border-border bg-surface px-3 py-1 text-sm text-text-primary shadow-sm',
        'placeholder:text-text-secondary',
        'focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-1 focus:ring-offset-background',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
