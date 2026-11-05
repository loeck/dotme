import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Many scene tests generate a whole lake world (terrain, forest, lake bed): 2-5 s each on a
    // developer machine and more on CI runners, where the 5 s default timed them out.
    testTimeout: 30_000,
  },
})
