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
    include: ['test/stress/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    restoreMocks: true,
  },
})
