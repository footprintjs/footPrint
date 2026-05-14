/**
 * runId PROPERTY tests — invariants over many random / many runs.
 *
 * Pattern 4 of 7 (property). The generator's contract:
 *   - N invocations produce N distinct ids.
 *   - The set of ids is monotonic in lexicographic order.
 *   - Holds at any N (fuzz from 1 to 1000).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { _resetRunIdStateForTesting, generateRunId } from '../../../src/lib/runner/runId.js';

beforeEach(() => {
  _resetRunIdStateForTesting();
});

describe('runId — property', () => {
  it.each([1, 5, 50, 500, 1000, 5000])('N=%i invocations always produce N distinct sortable ids', (n) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push(generateRunId());
    expect(new Set(ids).size).toBe(n);
    expect([...ids].sort()).toEqual(ids);
  });

  it('monotonic-clock guard: even if generator is called within the same millisecond, ids stay distinct + sortable', () => {
    // Generate many ids in a tight loop — multiple should land in the
    // same Date.now() millisecond. Counter must tie-break correctly.
    const ids: string[] = [];
    for (let i = 0; i < 10000; i++) ids.push(generateRunId());
    expect(new Set(ids).size).toBe(10000);
    expect([...ids].sort()).toEqual(ids);
  });
});
