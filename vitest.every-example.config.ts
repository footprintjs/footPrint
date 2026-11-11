import { defineConfig } from 'vitest/config';

import { EVERY_EXAMPLE_TEST } from './vitest.built-package-tests';

/** `npm run test:every-example`: runs each example in a child process. Needs `dist/`: build first. */
export default defineConfig({
  test: {
    globals: true,
    include: [EVERY_EXAMPLE_TEST],
  },
});
