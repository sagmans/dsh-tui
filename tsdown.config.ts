import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/startup.ts',
    'src/services/client.ts',
    'src/features/shell/index.ts',
    'src/features/sessions/index.ts',
    'src/features/conversation/index.ts',
    'src/features/model-selection/index.ts',
    'src/features/input-trigger/index.ts',
    'src/features/tools/index.ts',
    'src/features/interactions/index.ts',
    'src/features/operations/index.ts',
    'src/features/trajectory/index.ts',
    'src/features/settings/index.ts',
    'src/contracts/index.ts',
    'src/testing/index.ts',
  ],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  dts: true,
  sourcemap: true,
  clean: true,
})
