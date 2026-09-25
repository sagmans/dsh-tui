import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Absolute alias for the plugin sources: relative parent traversal is
      // unreliable under this test runner, and an alias keeps specs explicit.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    reporters: 'dot',
    coverage: {
      provider: 'v8',
      // Only the shipped plugin counts: specs, fixtures, and tooling would
      // otherwise inflate the number the audit judges.
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
})
