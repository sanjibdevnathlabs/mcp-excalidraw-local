import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/backend/**/*.test.ts', 'tests/frontend/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    testTimeout: 15000,
    hookTimeout: 15000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/setup.ts', 'src/index.ts'],
    },
  },
  resolve: {
    alias: {
      // Vitest resolves .js imports to .ts source files
    },
  },
});
