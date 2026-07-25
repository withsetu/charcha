// shadcn/ui's Textarea, from the registry (CLAUDE.md: a missing control is a signal to
// add it, not to invent one). The import path is the only change — this project keeps
// `cn` beside the components rather than under an `@/lib` alias, the same edit every
// other file in this directory carries.

import * as React from 'react'

import { cn } from './utils'

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:ring-destructive/40',
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
