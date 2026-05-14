/**
 * runId LOAD tests — sustained throughput.
 *
 * Pattern 7 of 7 (load). 100k generations sustained without
 * collisions. Models a high-throughput agent service generating
 * many runs per second.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { _resetRunIdStateForTesting, generateRunId } from '../../../src/lib/runner/runId.js';

beforeEach(() => {
  _resetRunIdStateForTesting();
});

describe('runId — load', () => {
  it('100k consecutive generations: zero collisions', () => {
    const N = 100_000;
    const seen = new Set<string>();
    for (let i = 0; i < N; i++) seen.add(generateRunId());
    expect(seen.size).toBe(N);
  });

  it('100k generations complete in under 200ms (sustained throughput > 500k/sec)', () => {
    const N = 100_000;
    const start = process.hrtime.bigint();
    for (let i = 0; i < N; i++) generateRunId();
    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1_000_000;
    expect(ms).toBeLessThan(200);
  });
});
