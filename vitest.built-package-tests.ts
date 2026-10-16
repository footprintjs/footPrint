/**
 * Tests that run a BUILT package (`dist/`) — the examples import `footprintjs`, which
 * resolves through `package.json#main`. They run only from `npm run test:examples`
 * (vitest.examples.config.ts), which builds first, so a plain `npm test` on a fresh
 * checkout needs no `dist/` and no test ever rebuilds (deletes) `dist/` mid-suite.
 */
export const BUILT_PACKAGE_TESTS = [
  'test/lib/engine/scenario/fork-example.test.ts',
  'test/lib/detach/examples-integration.test.ts',
  'test/lib/attempt/integration/traceparent-example.test.ts',
  'test/lib/budget/integration/time-budget-example.test.ts',
  'test/lib/attempt/integration/attempts-inside-a-stage-example.test.ts',
  'test/lib/sinks/integration/crash-safe-record-example.test.ts',
];
