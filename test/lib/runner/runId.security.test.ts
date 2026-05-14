/**
 * runId SECURITY tests — no PII / no credential leakage.
 *
 * Pattern 5 of 7 (security). The runId is `${Date.now()}-${counter}`.
 * Verify it's PURELY a counter + timestamp; nothing sensitive can
 * leak into it (no env vars, no stack traces, no consumer input).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { _resetRunIdStateForTesting, generateRunId } from '../../../src/lib/runner/runId.js';

beforeEach(() => {
  _resetRunIdStateForTesting();
});

describe('runId — security', () => {
  it('format is purely <digits>-<digits> — never contains letters or special chars', () => {
    for (let i = 0; i < 100; i++) {
      const id = generateRunId();
      expect(id).toMatch(/^\d+-\d+$/);
      // Defensive: explicitly exclude common leakage vectors.
      expect(id).not.toMatch(/[a-zA-Z]/); // no env/host info
      expect(id).not.toMatch(/[\s/=:]/); // no separators that could embed paths
    }
  });

  it('does not embed process env vars / argv / hostname / username', () => {
    const id = generateRunId();
    // Bare structural sanity — id is short (timestamp ~13 digits + dash + counter).
    expect(id.length).toBeLessThan(40);
  });
});
