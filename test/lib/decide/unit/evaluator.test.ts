/**
 * Tests for decide/evaluator -- Prisma-style filter evaluation.
 *
 * Covers: unit (all operators), boundary, security (prototype pollution, redaction), performance.
 */
import { describe, expect, it, vi } from 'vitest';

import { disableDevMode, enableDevMode } from '../../../../src/index.js';
import { evaluateFilter } from '../../../../src/lib/decide/evaluator';
import type { WhereFilter } from '../../../../src/lib/decide/types';

// -- Helpers -----------------------------------------------------------------

function makeGetter(state: Record<string, unknown>) {
  return (key: string) => state[key];
}

const noRedaction = () => false;

// -- Unit: individual operators ----------------------------------------------

describe('evaluator -- unit: eq operator', () => {
  it('matches equal values', () => {
    const { matched } = evaluateFilter(makeGetter({ plan: 'premium' }), noRedaction, { plan: { eq: 'premium' } });
    expect(matched).toBe(true);
  });

  it('fails on unequal values', () => {
    const { matched } = evaluateFilter(makeGetter({ plan: 'trial' }), noRedaction, { plan: { eq: 'premium' } });
    expect(matched).toBe(false);
  });
});

describe('evaluator -- unit: ne operator', () => {
  it('matches unequal values', () => {
    const { matched } = evaluateFilter(makeGetter({ status: 'active' }), noRedaction, { status: { ne: 'banned' } });
    expect(matched).toBe(true);
  });

  it('fails on equal values', () => {
    const { matched } = evaluateFilter(makeGetter({ status: 'banned' }), noRedaction, { status: { ne: 'banned' } });
    expect(matched).toBe(false);
  });
});

describe('evaluator -- unit: gt/gte/lt/lte operators', () => {
  it('gt matches when actual > threshold', () => {
    const { matched } = evaluateFilter(makeGetter({ score: 750 }), noRedaction, { score: { gt: 700 } });
    expect(matched).toBe(true);
  });

  it('gt fails when actual === threshold', () => {
    const { matched } = evaluateFilter(makeGetter({ score: 700 }), noRedaction, { score: { gt: 700 } });
    expect(matched).toBe(false);
  });

  it('gte matches when actual === threshold', () => {
    const { matched } = evaluateFilter(makeGetter({ score: 700 }), noRedaction, { score: { gte: 700 } });
    expect(matched).toBe(true);
  });

  it('lt matches when actual < threshold', () => {
    const { matched } = evaluateFilter(makeGetter({ dti: 0.38 }), noRedaction, { dti: { lt: 0.43 } });
    expect(matched).toBe(true);
  });

  it('lte matches when actual === threshold', () => {
    const { matched } = evaluateFilter(makeGetter({ dti: 0.43 }), noRedaction, { dti: { lte: 0.43 } });
    expect(matched).toBe(true);
  });
});

describe('evaluator -- unit: in/notIn operators', () => {
  it('in matches when value is in array', () => {
    const { matched } = evaluateFilter(makeGetter({ region: 'US' }), noRedaction, { region: { in: ['US', 'EU'] } });
    expect(matched).toBe(true);
  });

  it('in fails when value is not in array', () => {
    const { matched } = evaluateFilter(makeGetter({ region: 'CN' }), noRedaction, { region: { in: ['US', 'EU'] } });
    expect(matched).toBe(false);
  });

  it('notIn matches when value is not in array', () => {
    const { matched } = evaluateFilter(makeGetter({ region: 'CN' }), noRedaction, { region: { notIn: ['US', 'EU'] } });
    expect(matched).toBe(true);
  });

  it('notIn fails when value is in array', () => {
    const { matched } = evaluateFilter(makeGetter({ region: 'US' }), noRedaction, { region: { notIn: ['US', 'EU'] } });
    expect(matched).toBe(false);
  });
});

// -- Unit: AND semantics (all keys must match) -------------------------------

describe('evaluator -- unit: AND semantics', () => {
  it('matches when ALL conditions pass', () => {
    const { matched } = evaluateFilter(makeGetter({ score: 750, dti: 0.38 }), noRedaction, {
      score: { gt: 700 },
      dti: { lt: 0.43 },
    });
    expect(matched).toBe(true);
  });

  it('fails when ANY condition fails', () => {
    const { matched } = evaluateFilter(makeGetter({ score: 750, dti: 0.5 }), noRedaction, {
      score: { gt: 700 },
      dti: { lt: 0.43 },
    });
    expect(matched).toBe(false);
  });

  it('multiple operators on same key are ANDed', () => {
    const { matched } = evaluateFilter(makeGetter({ score: 720 }), noRedaction, { score: { gt: 600, lt: 800 } });
    expect(matched).toBe(true);
  });

  it('fails range check when value outside range', () => {
    const { matched } = evaluateFilter(makeGetter({ score: 900 }), noRedaction, { score: { gt: 600, lt: 800 } });
    expect(matched).toBe(false);
  });
});

// -- Unit: condition trace output --------------------------------------------

describe('evaluator -- unit: condition traces', () => {
  it('records per-condition trace with key, op, threshold, actual, result', () => {
    const { conditions } = evaluateFilter(makeGetter({ score: 750 }), noRedaction, { score: { gt: 700 } });
    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toEqual({
      key: 'score',
      op: 'gt',
      threshold: 700,
      actualSummary: '750',
      result: true,
      redacted: false,
    });
  });

  it('records multiple conditions for multi-key filter', () => {
    const { conditions } = evaluateFilter(makeGetter({ score: 750, plan: 'premium' }), noRedaction, {
      score: { gt: 700 },
      plan: { eq: 'premium' },
    });
    expect(conditions).toHaveLength(2);
  });

  it('records failed conditions with result=false', () => {
    const { conditions } = evaluateFilter(makeGetter({ score: 600 }), noRedaction, { score: { gt: 700 } });
    expect(conditions[0].result).toBe(false);
  });
});

// -- Boundary: edge cases ----------------------------------------------------

describe('evaluator -- boundary', () => {
  it('undefined key value', () => {
    const { matched, conditions } = evaluateFilter(makeGetter({}), noRedaction, { score: { gt: 700 } });
    expect(matched).toBe(false);
    expect(conditions[0].actualSummary).toBe('undefined');
  });

  it('null key value', () => {
    const { matched } = evaluateFilter(makeGetter({ score: null }), noRedaction, { score: { gt: 700 } });
    expect(matched).toBe(false);
  });
});

// -- Security: prototype pollution -------------------------------------------

describe('evaluator -- security: prototype pollution', () => {
  it('skips __proto__ key', () => {
    const filter = { __proto__: { gt: 0 }, score: { gt: 700 } } as any;
    const { conditions } = evaluateFilter(makeGetter({ score: 750 }), noRedaction, filter);
    // Only score condition, __proto__ skipped
    const keys = conditions.map((c) => c.key);
    expect(keys).not.toContain('__proto__');
  });

  it('skips constructor key', () => {
    const filter = { constructor: { eq: 'Object' }, score: { gt: 700 } } as any;
    const { conditions } = evaluateFilter(makeGetter({ score: 750 }), noRedaction, filter);
    const keys = conditions.map((c) => c.key);
    expect(keys).not.toContain('constructor');
  });

  it('toString key causes rule to fail (denied key)', () => {
    const filter = { toString: { eq: 'test' } } as any;
    const { matched, conditions } = evaluateFilter(makeGetter({}), noRedaction, filter);
    expect(conditions).toHaveLength(0);
    expect(matched).toBe(false); // denied key = rule fails
  });

  it('empty filter does NOT match (prevents vacuous truth)', () => {
    const { matched, conditions } = evaluateFilter(makeGetter({ x: 1 }), noRedaction, {});
    expect(matched).toBe(false);
    expect(conditions).toHaveLength(0);
  });
});

// -- Security: unknown operator fails rule (not silently matches) ------------

describe('evaluator -- security: unknown operator', () => {
  it('unknown operator causes rule to fail (not silently match)', () => {
    const { matched, conditions } = evaluateFilter(makeGetter({ score: 750 }), noRedaction, {
      score: { greaterThan: 700 },
    } as any);
    expect(matched).toBe(false);
    expect(conditions).toHaveLength(1);
    expect(conditions[0].op).toBe('greaterThan');
    expect(conditions[0].result).toBe(false);
  });

  it('dev mode warns on unknown operator, naming the operator and key (B5)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    enableDevMode();
    try {
      evaluateFilter(makeGetter({ score: 750 }), noRedaction, { score: { greaterThan: 700 } } as any);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = warnSpy.mock.calls[0]?.[0] as string;
      expect(message).toContain('unknown operator "greaterThan"');
      expect(message).toContain('key "score"');
      expect(message).toContain('eq, ne, gt, gte, lt, lte, in, notIn');
    } finally {
      disableDevMode();
      warnSpy.mockRestore();
    }
  });

  it('production (dev mode OFF) stays silent on unknown operator', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    disableDevMode();
    try {
      const { matched } = evaluateFilter(makeGetter({ score: 750 }), noRedaction, {
        score: { greaterThan: 700 },
      } as any);
      expect(matched).toBe(false); // behavior unchanged — only the warn is gated
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('known operators never trigger the dev warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    enableDevMode();
    try {
      const { matched } = evaluateFilter(makeGetter({ score: 750 }), noRedaction, { score: { gt: 700 } });
      expect(matched).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      disableDevMode();
      warnSpy.mockRestore();
    }
  });
});

// -- Security: redaction -----------------------------------------------------

describe('evaluator -- security: redaction', () => {
  it('shows [REDACTED] for redacted keys', () => {
    const isRedacted = (key: string) => key === 'ssn';
    const { conditions } = evaluateFilter(makeGetter({ ssn: '123-45-6789', score: 750 }), isRedacted, {
      ssn: { ne: '' },
      score: { gt: 700 },
    });
    const ssnCond = conditions.find((c) => c.key === 'ssn');
    expect(ssnCond?.actualSummary).toBe('[REDACTED]');
    expect(ssnCond?.redacted).toBe(true);

    const scoreCond = conditions.find((c) => c.key === 'score');
    expect(scoreCond?.actualSummary).toBe('750');
    expect(scoreCond?.redacted).toBe(false);
  });
});

// -- Security: in/notIn size cap ---------------------------------------------

describe('evaluator -- security: array size cap', () => {
  it('throws when in array exceeds 1000 elements', () => {
    const bigArray = new Array(1001).fill('x');
    expect(() => evaluateFilter(makeGetter({ region: 'US' }), noRedaction, { region: { in: bigArray } })).toThrow(
      'exceeds maximum size',
    );
  });

  it('allows in array at exactly 1000 elements', () => {
    const arr = new Array(1000).fill('x');
    expect(() => evaluateFilter(makeGetter({ region: 'US' }), noRedaction, { region: { in: arr } })).not.toThrow();
  });
});

// -- Performance: throughput -------------------------------------------------

describe('evaluator -- performance', () => {
  /**
   * Filter evaluation stays LINEAR in the number of evaluations.
   *
   * Measured as a scaling RATIO, never as absolute milliseconds. An
   * "under 50ms" assertion says as much about how busy the machine is as
   * about the evaluator, so on a shared CI runner it fails at random — a
   * red build that means nothing, which is worse than no test. Both halves
   * of a ratio absorb the same machine load, so it cancels out.
   *
   * The real regression this guards is an accidental quadratic: a nested
   * loop over rules, or a per-call allocation that grows with call count.
   * Ten times the work takes ten times as long (measured ~10.3x); the bound
   * is 25x, so genuine noise passes and a quadratic blow-up (which would
   * land near 100x) fails.
   */
  it('scales linearly — 10x the filters costs well under 25x the time', () => {
    const state = { score: 750, plan: 'premium', region: 'US' };
    const filter: WhereFilter = { score: { gt: 700 }, plan: { eq: 'premium' }, region: { in: ['US', 'EU'] } };
    const getter = makeGetter(state);

    const timeEvaluations = (count: number): number => {
      const start = performance.now();
      for (let i = 0; i < count; i++) {
        evaluateFilter(getter, noRedaction, filter);
      }
      return performance.now() - start;
    };

    // Warm up first: without this the baseline would absorb JIT compilation
    // that the larger run does not pay, comparing two different things.
    timeEvaluations(20_000);

    const baseline = timeEvaluations(1_000);
    const tenfold = timeEvaluations(10_000);

    // Floor the denominator. The 1K baseline is a fraction of a millisecond,
    // where timer granularity alone can halve or double the reading; the floor
    // keeps the allowance from collapsing to near-zero. It only ever makes the
    // bound MORE forgiving, and the bound still scales up on a slow machine.
    const budget = Math.max(baseline, 1) * 25;
    expect(tenfold).toBeLessThan(budget);
  });
});
