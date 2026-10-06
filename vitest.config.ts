import { configDefaults, defineConfig } from 'vitest/config';

import { BUILT_PACKAGE_TESTS } from './vitest.built-package-tests';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...BUILT_PACKAGE_TESTS],
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
