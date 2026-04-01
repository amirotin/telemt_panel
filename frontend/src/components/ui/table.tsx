import type { HTMLAttributes, ThHTMLAttributes, TdHTMLAttributes, Ref } from 'react'
import { cn } from '@/lib/utils'

const Table = ({ className, ref, ...props }: HTMLAttributes<HTMLTableElement> & { ref?: Ref<HTMLTableElement> }) => (
  <div className="w-full overflow-auto">
    <table
      ref={ref}
      className={cn('w-full caption-bottom text-sm', className)}
      {...props}
    />
  </div>
)

const TableHeader = ({ className, ref, ...props }: HTMLAttributes<HTMLTableSectionElement> & { ref?: Ref<HTMLTableSectionElement> }) => (
  <thead ref={ref} className={cn('bg-surface', className)} {...props} />
)

const TableBody = ({ className, ref, ...props }: HTMLAttributes<HTMLTableSectionElement> & { ref?: Ref<HTMLTableSectionElement> }) => (
  <tbody ref={ref} className={cn('[&_tr:last-child]:border-0', className)} {...props} />
)

const TableRow = ({ className, ref, ...props }: HTMLAttributes<HTMLTableRowElement> & { ref?: Ref<HTMLTableRowElement> }) => (
  <tr
    ref={ref}
    className={cn(
      'border-b border-border transition-colors hover:bg-surface-hover',
      className,
    )}
    {...props}
  />
)

const TableHead = ({ className, ref, ...props }: ThHTMLAttributes<HTMLTableCellElement> & { ref?: Ref<HTMLTableCellElement> }) => (
  <th
    ref={ref}
    className={cn(
      'h-10 px-3 text-left align-middle text-xs font-medium text-text-secondary',
      className,
    )}
    {...props}
  />
)

const TableCell = ({ className, ref, ...props }: TdHTMLAttributes<HTMLTableCellElement> & { ref?: Ref<HTMLTableCellElement> }) => (
  <td
    ref={ref}
    className={cn('px-3 py-2 align-middle text-text-primary', className)}
    {...props}
  />
)

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell }
