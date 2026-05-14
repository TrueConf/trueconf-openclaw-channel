import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // jiti compiles src/ on-the-fly when many test files import it in parallel.
    // On Windows the cold-start cost is high; the default 5s timeout fails for
    // small "import-only" smoke tests (e.g. `channel-plugin-shape`). 30s is
    // generous enough to swallow first-import compile, no-op for steady state.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
