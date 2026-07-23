import { env, exports } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'

const origin = 'https://charcha.example'

describe('GET /health', () => {
  it('reports the Worker and its D1 binding as healthy', async () => {
    const response = await exports.default.fetch(`${origin}/health`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok', database: 'ok' })
  })

  it('is not cached, so it reflects the state of this request', async () => {
    const response = await exports.default.fetch(`${origin}/health`)

    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('reports the database as unhealthy rather than failing silently', async () => {
    vi.spyOn(env.DB, 'prepare').mockImplementation(() => {
      throw new Error('D1_ERROR: no such database')
    })

    const response = await exports.default.fetch(`${origin}/health`)

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ status: 'degraded', database: 'error' })

    vi.restoreAllMocks()
  })
})

describe('an unknown route', () => {
  it('is a 404, and says so in plain text', async () => {
    const response = await exports.default.fetch(`${origin}/no-such-route`)

    expect(response.status).toBe(404)
    expect(await response.text()).toBe('Not found')
  })
})
