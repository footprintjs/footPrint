/**
 * runId PERFORMANCE tests — single-call latency budget.
 *
 * Pattern 6 of 7 (perf). The generator is on the hot path of every
 * executor.run(). Should be < 1µs per call (1000ns).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { _resetRunIdStateForTesting, generateRunId } from '../../../src/lib/runner/runId.js';

beforeEach(() => {
  _resetRunIdStateForTesting();
});

describe('runId — performance', () => {
  it('< 3µs per call (averaged over 10k calls)', () => {
    const N = 10_000;
    const start = process.hrtime.bigint();
    for (let i = 0; i < N; i++) generateRunId();
    const end = process.hrtime.bigint();
    const totalNs = Number(end - start);
    const perCallNs = totalNs / N;
    // Budget: 3000ns = 3µs per call. Originally 1000ns; loosened to
    // accommodate GitHub Actions runner CPU contention (steady-state
    // is ~600ns, but CI runs routinely hit 1000-1100ns). Test intent
    // is regression detection (>10x), not absolute perf.
    expect(perCallNs).toBeLessThan(3000);
  });
});
