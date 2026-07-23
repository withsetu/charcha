import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

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
          }),
        ],
        test: {
          name: 'worker',
          include: ['test/worker/**/*.test.ts'],
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
