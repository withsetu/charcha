// The dashboard's entry point, bundled by `pnpm build:dashboard` into
// public/admin/app.js — a static asset, so the browser fetches it without invoking or
// billing the Worker (the same trade wrangler.jsonc records for embed.js).
//
// There is no server-rendered markup and no bootstrap data in the document: the app
// asks `GET /admin/api/session` for itself. That is what lets the shell in
// src/dashboard/document.ts carry a `script-src 'self'` Content-Security-Policy with
// no inline script and no nonce — on the one surface in this project where an XSS
// would land on an authenticated session.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app'

const mount = document.getElementById('charcha-dashboard')

if (mount === null) {
  // The element is written by the shell this bundle is loaded from, so its absence
  // means the two have drifted apart. Said out loud rather than left as a blank page:
  // a dashboard that renders nothing and logs nothing is indistinguishable from a
  // deployment whose script failed to load.
  console.error('charcha: no #charcha-dashboard element to mount into')
} else {
  createRoot(mount).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
