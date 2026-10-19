import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.js'],
    include: ['test/**/*.test.js'],
    // PGlite's WASM runtime crashes intermittently ("Worker exited unexpectedly") when several
    // instances run concurrently; running test files one at a time avoids the contention.
    pool: 'forks',
    fileParallelism: false,
  },
});
