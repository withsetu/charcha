import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

// Every test file gets the real schema, applied from the same migrations the
// deployment runs — never a hand-written fixture that can drift from them.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
