import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'build/coverage',
      reporter: ['cobertura', 'text', 'text-summary'],
      thresholds: {
        statements: 95,
        branches: 85,
        functions: 98,
        lines: 98,
      },
    },
  },
});
