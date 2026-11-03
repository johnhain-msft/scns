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
    include: ['test/e2e/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    restoreMocks: true,
    // Match the unit-test config: silence the pino logger so e2e
    // stdout cannot trip the no-unresolved rubric (qc=5f6f8a0d).
    setupFiles: ['./test/vitest.setup.ts'],
  },
})
