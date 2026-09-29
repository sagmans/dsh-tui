import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const HERDR_ENV_PREFIX = 'HERDR_'

// Workers must never borrow the invoking pane's authority: lifecycle fixture
// teardown can release its real agent row. Clearing before workers start also
// keeps unstubAllEnvs from restoring live coordinates after a fake-env test.
for (const key of Object.keys(process.env)) {
  if (key.startsWith(HERDR_ENV_PREFIX)) delete process.env[key]
}

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
