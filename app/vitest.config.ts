import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // RLS tests mutate shared GUCs and toggle FORCE on shared tables.
    // Run serially so one test cannot pollute another's session state.
    fileParallelism: false,
  },
})
