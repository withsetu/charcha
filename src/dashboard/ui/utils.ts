// Every other file in this directory is **shadcn/ui registry source**, fetched from
// the registry rather than written here. CLAUDE.md's rule is that dashboard controls
// come from shadcn/ui and that a missing control is a signal to add it from the
// registry, not to invent one — so this directory is the registry's output, and the
// place to look when a control is missing is the registry.
//
// Three edits are applied to each of them, and only these three:
//
//   1. `@/lib/utils` becomes `./utils`, and `@/registry/new-york-v4/ui/x` becomes
//      `./x`. The registry emits Next.js path aliases; this project has none, and
//      adding one would be a fourth thing to keep in step across the tsconfigs.
//   2. The `"use client"` directive is dropped. It is a React Server Components
//      marker only Next.js reads, and esbuild warns that it could not preserve it.
//   3. Prettier reformats them to this repository's style, because `pnpm format:check`
//      is part of the gate.
//
// Nothing else is changed. A component that needs different behaviour is wrapped in
// src/dashboard/components/, never edited here — an edited registry file cannot be
// re-fetched for an upstream fix without the edit being re-applied by hand.

import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
