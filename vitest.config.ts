import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@scns': resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    root: '.',
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**', 'test/stress/**', 'node_modules', 'dist'],
    // Postmortem qc=5f6f8a0d: silences the broker pino logger before
    // any test file imports `src/shared/logger.ts`, so broker warn/info
    // lines (which contain "Unresolved issues (TODO/FIXME/HACK) detected
    // in output" etc.) cannot leak into combined test stdout and
    // false-fire the quality-gate `no-unresolved` rubric.
    setupFiles: ['./test/vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts', 'src/**/*.d.ts', 'src/cli.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
    testTimeout: 10_000,
    hookTimeout: 10_000,
    restoreMocks: true,
  },
})
