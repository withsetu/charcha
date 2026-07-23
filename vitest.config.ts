import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Tests run against the migrations themselves, so a schema change that breaks a
// query breaks a test rather than a deployment.
const migrations = await readD1Migrations('./migrations')

export default defineConfig({
  test: {
    projects: [
      {
        // Worker code is tested inside workerd, against the same bindings the
        // deployed Worker gets. A Worker that passes under node proves little.
        plugins: [
          cloudflareTest({
            main: './src/index.ts',
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
          }),
        ],
        test: {
          name: 'worker',
          include: ['test/worker/**/*.test.ts'],
          setupFiles: ['./test/worker/apply-migrations.ts'],
        },
      },
      {
        // Build tooling runs on the developer's machine and in CI, not in
        // workerd — it reads the filesystem and shells out to esbuild.
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/node/**/*.test.ts'],
        },
      },
    ],
  },
})
