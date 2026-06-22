import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

// Separate config for the NestJS e2e: NestJS DI needs emitted decorator metadata, which
// esbuild (vitest's default transform) does not produce on Node 24. SWC does.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/nest.e2e.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
  plugins: [
    swc.vite({
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
})
