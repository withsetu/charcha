import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import app from '../../src/index'

// The pool gives tests the *same* app instance the Worker serves, so a route
// registered here is a route the real error handler sees.
app.get('/test-only/throws', () => {
  throw new Error('a secret only the server should know')
})

describe('an unhandled error', () => {
  it('is a 500 that leaks nothing about what went wrong', async () => {
    const response = await exports.default.fetch('https://charcha.example/test-only/throws')
    const body = await response.text()

    expect(response.status).toBe(500)
    expect(body).toBe('Internal error')
    expect(body).not.toContain('secret')
  })
})
