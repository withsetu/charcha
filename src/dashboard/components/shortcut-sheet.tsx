// The `?` sheet.
//
// Generated from `SHORTCUTS` in src/dashboard/keys.ts rather than typed out here, so
// the documentation of a binding sits in the same file as the binding.
//
// shadcn's Dialog, and specifically for what Radix does under it: a focus trap, a
// return of focus to wherever it came from on close, `Escape` to dismiss, and
// `aria-modal` with the rest of the page marked hidden. A keyboard-first surface
// cannot afford a panel that focus can wander out of, and none of that is worth
// reimplementing.
//
// Enforced by test/dashboard/triage.test.tsx.

import { SHORTCUTS } from '../keys'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Kbd } from '../ui/kbd'

export function ShortcutSheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            The queue is built to be cleared without the mouse. Every key below works whenever the
            list has focus.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-3 text-sm">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.keys} className="col-span-2 grid grid-cols-subgrid items-baseline">
              <dt>
                {/*
                  `whitespace-pre` because a few rows name alternatives — `J  or  ↓`,
                  `1  2  3` — and HTML would collapse the double spaces that separate
                  them. Everything else about the keycap is the shared treatment in
                  src/dashboard/ui/kbd.tsx, which is the fix for #135: this used to be
                  the only place a `<kbd>` looked like a key.
                */}
                <Kbd className="whitespace-pre">{shortcut.keys}</Kbd>
              </dt>
              <dd className="text-muted-foreground">{shortcut.description}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  )
}
