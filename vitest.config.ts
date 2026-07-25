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
            miniflare: {
              bindings: { TEST_MIGRATIONS: migrations },
              // A second D1 database, declared here and not in wrangler.jsonc, so it
              // exists for tests and on no deployment. `apply-migrations.ts` migrates
              // `DB` before every test file, so this is the only way to reach the
              // state the deploy button actually leaves behind: a database that
              // exists, answers `select 1`, and has no Charcha schema in it (#140).
              d1Databases: ['DB', 'TEST_EMPTY_DB'],
            },
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
      {
        // The embed runs in a browser, and neither environment above has a DOM —
        // which is why src/embed/mount.ts shipped with no test able to run at all
        // (#91). happy-dom over jsdom: it adds 6 packages to this lockfile where
        // jsdom adds 36, and it implements `scrollIntoView`, which mount.ts calls
        // on its write-error path and jsdom does not define at all — under jsdom
        // that call would have to be stubbed, hiding the very line under test.
        // Both measured on 2026-07-25; the method is on the PR closing #91.
        //
        // The include is a directory glob rather than a file list on purpose. The
        // next DOM module must arrive tested, and a config that has to be edited
        // first is a config that gets skipped — which is exactly how #91 happened.
        test: {
          name: 'dom',
          environment: 'happy-dom',
          include: ['test/dom/**/*.test.ts'],
          // A real page address, because the embed reads the thread for the page
          // it is on from `location.href` (src/embed/api.ts). happy-dom's own
          // default is `about:blank`, against which a test cannot tell a read URL
          // built from the page from one that ignored it.
          environmentOptions: { happyDOM: { url: 'https://example.com/posts/hello/' } },
        },
      },
      {
        // The moderation dashboard (#13). A separate project from `dom` rather than
        // a widened glob on it, for two reasons that are both about the address:
        // these tests need to be *on* `/admin` for a same-origin fetch assertion to
        // mean anything, and the embed's project is pinned to a reader's page URL.
        // The two cannot share one `environmentOptions`.
        //
        // React components are `.tsx`, so the glob takes both extensions.
        test: {
          name: 'dashboard',
          environment: 'happy-dom',
          include: ['test/dashboard/**/*.test.ts', 'test/dashboard/**/*.test.tsx'],
          environmentOptions: {
            happyDOM: { url: 'https://comments.example.com/admin' },
          },
        },
      },
    ],
  },
})
