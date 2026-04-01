import type { HTMLAttributes, Ref } from 'react'
import { cn } from '@/lib/utils'

const Card = ({ className, ref, ...props }: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }) => (
  <div
    ref={ref}
    className={cn('rounded-lg border border-border bg-surface', className)}
    {...props}
  />
)

const CardHeader = ({ className, ref, ...props }: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }) => (
  <div ref={ref} className={cn('flex flex-col space-y-1.5 p-4', className)} {...props} />
)

const CardTitle = ({ className, ref, ...props }: HTMLAttributes<HTMLHeadingElement> & { ref?: Ref<HTMLHeadingElement> }) => (
  <h3
    ref={ref}
    className={cn('text-sm font-semibold leading-none tracking-tight text-text-primary', className)}
    {...props}
  />
)

const CardContent = ({ className, ref, ...props }: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }) => (
  <div ref={ref} className={cn('p-4 pt-0', className)} {...props} />
)

export { Card, CardHeader, CardTitle, CardContent }
