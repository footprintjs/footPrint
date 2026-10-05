import { assert as assertProperty, integer, property } from 'fast-check';
import { describe, expect, it } from 'vitest';

import { resumePropertyParameters } from './resume-property-config.js';

describe('resume property replay configuration', () => {
  it('keeps 160 cases per mode with distinct stable seeds', () => {
    expect(resumePropertyParameters('same', {})).toEqual({ numRuns: 160, seed: 20261005 });
    expect(resumePropertyParameters('cross', {})).toEqual({ numRuns: 160, seed: 20261006 });
  });

  it.each(['0', '-2147483648', '2147483647'])(
    'accepts the signed 32-bit seed %s without changing the run count',
    (seed) => {
      expect(resumePropertyParameters('same', { RESUME_PROPERTY_SEED: seed })).toEqual({
        numRuns: 160,
        seed: Number(seed),
      });
    },
  );

  it.each(['', ' ', '1\n', '1\r', '1.5', 'NaN', 'Infinity', '0x10', '1e3', '12x', '+1', '2147483648', '-2147483649'])(
    'refuses an invalid seed override %j',
    (seed) => {
      expect(() => resumePropertyParameters('same', { RESUME_PROPERTY_SEED: seed })).toThrow(/RESUME_PROPERTY_SEED/);
    },
  );

  it('uses the explicit seed for either resume mode', () => {
    const env = { RESUME_PROPERTY_SEED: '42' };
    expect(resumePropertyParameters('same', env)).toEqual(resumePropertyParameters('cross', env));
  });

  it('requires an explicit seed when a replay path is supplied', () => {
    expect(() => resumePropertyParameters('same', { RESUME_PROPERTY_PATH: '0:1' })).toThrow(
      /requires RESUME_PROPERTY_SEED/,
    );
  });

  it.each(['', ' ', '1\n', '1\r', ':', ':1', '1:', '-1', '1:-1', '1.5', '1:2.5', '1e3', 'NaN', '1:9007199254740992'])(
    'refuses an invalid replay path %j',
    (path) => {
      expect(() =>
        resumePropertyParameters('cross', { RESUME_PROPERTY_SEED: '42', RESUME_PROPERTY_PATH: path }),
      ).toThrow(/RESUME_PROPERTY_PATH/);
    },
  );

  it.each(['0', '12', '1:0:3'])('replays only the selected case at path %s without further shrinking', (path) => {
    expect(resumePropertyParameters('cross', { RESUME_PROPERTY_SEED: '-42', RESUME_PROPERTY_PATH: path })).toEqual({
      numRuns: 1,
      seed: -42,
      path,
      endOnFailure: true,
    });
  });

  it('preserves native seed/path/cause diagnostics and can replay the reported counterexample', () => {
    const cause = new Error('deliberate property failure');
    const seen: number[] = [];
    const failingProperty = property(integer({ min: 1, max: 100 }), (value) => {
      seen.push(value);
      throw cause;
    });
    let failure: unknown;
    try {
      assertProperty(failingProperty, resumePropertyParameters('same', {}));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toHaveProperty('cause', cause);
    const replay = (failure as Error).message.match(/\{ seed: (-?\d+), path: "([\d:]+)", endOnFailure: true \}/);
    if (replay === null) throw new Error('The native failure did not report its seed and replay path');
    expect(replay[1]).toBe('20261005');
    const counterexample = seen[seen.length - 1];
    seen.length = 0;
    expect(() =>
      assertProperty(
        failingProperty,
        resumePropertyParameters('same', { RESUME_PROPERTY_SEED: replay[1], RESUME_PROPERTY_PATH: replay[2] }),
      ),
    ).toThrow(/seed: 20261005/);
    expect(seen).toEqual([counterexample]);
  });
});
