// Test-only binding, supplied by vitest.config.ts, which reads ./migrations at
// startup and hands them to Miniflare.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[]
  }
}
