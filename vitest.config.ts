import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const HERDR_ENV_PREFIX = 'HERDR_'

// Rendering fixtures must never borrow the invoking pane's lifecycle authority.
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
    // Match the plugin's Node host for golden frames; real-profile checks have
    // separate commands, so this runner does not stand in for actual usage.
    include: ['tests/golden/**/*.spec.ts'],
    environment: 'node',
    reporters: 'dot',
  },
})
