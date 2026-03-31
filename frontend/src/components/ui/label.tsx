import React from 'react'
import { cn } from '@/lib/utils'

export interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {}

const Label = ({ className, ref, ...props }: LabelProps & { ref?: React.Ref<HTMLLabelElement> }) => {
  return (
    <label
      ref={ref}
      className={cn(
        'text-sm font-medium leading-none text-text-secondary',
        'peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
        className,
      )}
      {...props}
    />
  )
}

export { Label }
