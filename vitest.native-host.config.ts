import { configDefaults, defineConfig } from 'vitest/config';

import { NATIVE_HOST_TEST } from './vitest.native-host-path';

/** A required second `npm test` phase: child processes do not compete with timed unit tests. */
export default defineConfig({
  test: {
    globals: true,
    globalSetup: ['test/setup/guard-repo-git.ts'],
    include: [NATIVE_HOST_TEST],
    exclude: configDefaults.exclude,
    fileParallelism: false,
    maxWorkers: 1,
    passWithNoTests: false,
  },
});
