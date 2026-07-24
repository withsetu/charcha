import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      '.wrangler/**',
      'node_modules/**',
      '.claude/**',
      'src/worker-configuration.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Root-level files that no tsconfig owns: the npm entry point and the
          // test runner's own config.
          allowDefaultProject: ['index.js', 'vitest.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Every comment this project takes is untrusted input, and every failure
      // has to reach someone. A dropped promise is how both go silently wrong.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    // Build tooling runs on node, and is plain JavaScript rather than typed
    // Worker source.
    files: ['**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['index.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
)
