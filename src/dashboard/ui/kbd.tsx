// shadcn/ui's `kbd`, vendored like the rest of this directory (`shadcn@latest add kbd`).
//
// It exists because `<kbd>` had two treatments in one app (#135): a keycap in the
// shortcut sheet and, in the view tabs, small dim text that read as a comment count.
// There is now one, and it is this — a missing control is a signal to take it from the
// registry rather than to invent a third.
//
// **One deviation from the registry, and it is the reason the component is used at
// all.** The registry's keycap is `bg-muted` with no border, which is invisible on a
// `bg-muted` surface — and `TabsList` is one (src/dashboard/ui/tabs.tsx), as is the
// inactive half of every tab in it. The border is what makes a keycap legible against
// any background, which is why the sheet's original hand-rolled treatment had one.
//
// `KbdGroup` is deliberately not vendored: every binding on this surface is a single
// key, so nothing here composes a combination.

import * as React from 'react'

import { cn } from './utils'

function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-sm border bg-muted px-1 font-sans text-xs font-medium text-muted-foreground select-none',
        "[&_svg:not([class*='size-'])]:size-3",
        className,
      )}
      {...props}
    />
  )
}

export { Kbd }
