import { defineConfig } from 'vitest/config';

import { BUILT_PACKAGE_TESTS } from './vitest.built-package-tests';

/** `npm run test:examples` — builds the package first, then runs the tests that need `dist/`. */
export default defineConfig({
  test: {
    globals: true,
    include: BUILT_PACKAGE_TESTS,
  },
});
