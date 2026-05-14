/**
 * runId UNIT tests — generator behavior in isolation.
 *
 * Pattern 1 of 7 (unit). The generator is a pure function that emits
 * sortable, monotonic, never-colliding strings. These tests cover the
 * generator alone — no executor, no event firing.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { _resetRunIdStateForTesting, generateRunId } from '../../../src/lib/runner/runId.js';

beforeEach(() => {
  _resetRunIdStateForTesting();
});

describe('runId — unit', () => {
  it('produces a non-empty string', () => {
    const id = generateRunId();
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  });

  it('produces a string in "<timestamp>-<zero-padded-counter>" format', () => {
    const id = generateRunId();
    expect(id).toMatch(/^\d+-\d{10}$/);
  });

  it('always increments the counter on consecutive calls', () => {
    const a = generateRunId();
    const b = generateRunId();
    const counterA = Number(a.split('-')[1]);
    const counterB = Number(b.split('-')[1]);
    expect(counterB).toBeGreaterThan(counterA);
  });

  it('lexicographic order matches generation order', () => {
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) ids.push(generateRunId());
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });
});
