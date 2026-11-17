import { describe, expect, it } from 'vitest';
import { pairedVerdict } from './index.mjs';

describe('paired acceptance', () => {
  const checks = ['setup', 'types', 'build', 'tests'];
  const pass = () => checks.map((key) => ({ key, ok: true }));
  it('requires every original command in order to actually pass', () => {
    expect(pairedVerdict(checks, pass())).toBe('pass');
    for (const steps of [
      null,
      [],
      pass().slice(1),
      [...pass(), { key: 'extra', ok: true }],
      pass().reverse(),
      pass().map((s, i) => (i === 2 ? { ...s, ok: false } : s)),
      pass().map((s, i) => (i === 2 ? { ...s, skipped: true } : s)),
      pass().map((s, i) => (i === 2 ? { ...s, ok: 'true' } : s)),
      new Array(4),
    ])
      expect(pairedVerdict(checks, steps)).toBe('BLOCKING');
  });
});
