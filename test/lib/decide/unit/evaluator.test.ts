/**
 * Tests for decide/evaluator -- Prisma-style filter evaluation.
 *
 * Covers: unit (all operators), boundary, security (prototype pollution, redaction), performance.
 */
import { describe, expect, it } from 'vitest';

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
  it('empty filter matches everything', () => {
    const { matched, conditions } = evaluateFilter(makeGetter({ x: 1 }), noRedaction, {});
    expect(matched).toBe(true);
    expect(conditions).toHaveLength(0);
  });

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

  it('skips toString key', () => {
    const filter = { toString: { eq: 'test' } } as any;
    const { matched, conditions } = evaluateFilter(makeGetter({}), noRedaction, filter);
    expect(conditions).toHaveLength(0);
    expect(matched).toBe(true); // no conditions = vacuously true
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
  it('evaluates 1K filters in under 50ms', () => {
    const state = { score: 750, plan: 'premium', region: 'US' };
    const filter = { score: { gt: 700 }, plan: { eq: 'premium' }, region: { in: ['US', 'EU'] } };
    const getter = makeGetter(state);
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      evaluateFilter(getter, noRedaction, filter);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});
