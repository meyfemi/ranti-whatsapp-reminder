import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // DB-backed tests share one test database, so run files serially.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
