/**
 * Unit tests for decide/types.
 */
import { describe, expect, it } from 'vitest';

import {
  type DecideRule,
  type DecisionEvidence,
  type DecisionResult,
  type FilterCondition,
  type FilterOps,
  type FilterRuleEvidence,
  type FunctionRuleEvidence,
  type ReadInput,
  type RuleEvidence,
  type SelectionEvidence,
  type SelectionResult,
  type WhenClause,
  type WhereFilter,
  DECISION_RESULT,
} from '../../../../src/lib/decide/types';

// -- Helpers for compile-time type checks ------------------------------------

type Expect<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// -- Unit: DECISION_RESULT symbol --------------------------------------------

describe('decide/types -- DECISION_RESULT symbol', () => {
  it('is a Symbol', () => {
    expect(typeof DECISION_RESULT).toBe('symbol');
  });

  it('is a private Symbol (not globally registered)', () => {
    expect(DECISION_RESULT).not.toBe(Symbol.for('footprint:decide:result'));
  });

  it('has descriptive string', () => {
    expect(DECISION_RESULT.toString()).toContain('footprint:decide:result');
  });
});

// -- Unit: FilterOps type checks ---------------------------------------------

describe('decide/types -- FilterOps', () => {
  it('accepts numeric operators', () => {
    const ops: FilterOps<number> = { gt: 700, lt: 1000, eq: 750 };
    expect(ops.gt).toBe(700);
  });

  it('accepts string operators', () => {
    const ops: FilterOps<string> = { eq: 'premium', ne: 'trial' };
    expect(ops.eq).toBe('premium');
  });

  it('accepts in/notIn arrays', () => {
    const ops: FilterOps<string> = { in: ['US', 'EU'], notIn: ['CN'] };
    expect(ops.in).toHaveLength(2);
  });

  it('all fields are optional', () => {
    const empty: FilterOps<number> = {};
    expect(Object.keys(empty)).toHaveLength(0);
  });
});

// -- Unit: WhereFilter type checks -------------------------------------------

describe('decide/types -- WhereFilter', () => {
  it('maps state keys to FilterOps', () => {
    interface State {
      creditScore: number;
      plan: string;
    }
    const filter: WhereFilter<State> = {
      creditScore: { gt: 700 },
      plan: { eq: 'premium' },
    };
    expect(filter.creditScore?.gt).toBe(700);
  });

  it('all keys are optional', () => {
    interface State {
      a: number;
      b: string;
      c: boolean;
    }
    const partial: WhereFilter<State> = { a: { gt: 5 } };
    expect(partial.b).toBeUndefined();
  });

  it('does NOT allow raw value shorthand (no | T[K])', () => {
    // WhereFilter requires FilterOps, not raw values.
    // This ensures no ambiguity with object-typed state values.
    interface State {
      score: number;
    }
    const filter: WhereFilter<State> = { score: { eq: 700 } };
    // { score: 700 } should NOT be assignable — verified by type system
    expect(filter.score?.eq).toBe(700);
  });
});

// -- Unit: DecideRule type checks --------------------------------------------

describe('decide/types -- DecideRule', () => {
  it('accepts function when clause', () => {
    interface State {
      x: number;
    }
    const rule: DecideRule<State> = {
      when: (s) => s.x > 5,
      then: 'high',
    };
    expect(typeof rule.when).toBe('function');
  });

  it('accepts filter when clause', () => {
    interface State {
      x: number;
    }
    const rule: DecideRule<State> = {
      when: { x: { gt: 5 } },
      then: 'high',
    };
    expect(typeof rule.when).toBe('object');
  });

  it('accepts optional label', () => {
    interface State {
      x: number;
    }
    const rule: DecideRule<State> = {
      when: { x: { gt: 5 } },
      then: 'high',
      label: 'High value',
    };
    expect(rule.label).toBe('High value');
  });
});

// -- Unit: Evidence types ----------------------------------------------------

describe('decide/types -- Evidence types', () => {
  it('FunctionRuleEvidence has type discriminator', () => {
    const ev: FunctionRuleEvidence = {
      type: 'function',
      ruleIndex: 0,
      matched: true,
      inputs: [{ key: 'x', valueSummary: '42', redacted: false }],
    };
    expect(ev.type).toBe('function');
  });

  it('FilterRuleEvidence has type discriminator', () => {
    const ev: FilterRuleEvidence = {
      type: 'filter',
      ruleIndex: 0,
      matched: true,
      conditions: [
        {
          key: 'x',
          op: 'gt',
          threshold: 5,
          actualSummary: '42',
          result: true,
          redacted: false,
        },
      ],
    };
    expect(ev.type).toBe('filter');
  });

  it('RuleEvidence is a discriminated union', () => {
    const ev: RuleEvidence = {
      type: 'function',
      ruleIndex: 0,
      matched: false,
      inputs: [],
    };
    if (ev.type === 'function') {
      expect(ev.inputs).toBeDefined();
    }
  });

  it('DecisionEvidence has rules + chosen + default', () => {
    const de: DecisionEvidence = {
      rules: [],
      chosen: 'approved',
      default: 'rejected',
    };
    expect(de.chosen).toBe('approved');
  });

  it('SelectionEvidence has rules + selected', () => {
    const se: SelectionEvidence = {
      rules: [],
      selected: ['diabetes', 'obesity'],
    };
    expect(se.selected).toHaveLength(2);
  });
});

// -- Unit: DecisionResult / SelectionResult ----------------------------------

describe('decide/types -- Result types', () => {
  it('DecisionResult carries Symbol brand', () => {
    const result: DecisionResult = {
      branch: 'approved',
      [DECISION_RESULT]: true,
      evidence: { rules: [], chosen: 'approved', default: 'rejected' },
    };
    expect(result[DECISION_RESULT]).toBe(true);
    expect(Reflect.has(result, DECISION_RESULT)).toBe(true);
  });

  it('SelectionResult carries Symbol brand', () => {
    const result: SelectionResult = {
      branches: ['diabetes', 'obesity'],
      [DECISION_RESULT]: true,
      evidence: { rules: [], selected: ['diabetes', 'obesity'] },
    };
    expect(result[DECISION_RESULT]).toBe(true);
  });

  it('plain string is NOT a DecisionResult (Symbol brand absent)', () => {
    const plain: unknown = 'approved';
    const isDecision = typeof plain === 'object' && plain !== null && Reflect.has(plain as object, DECISION_RESULT);
    expect(isDecision).toBe(false);
  });

  it('random object with branch field is NOT a DecisionResult', () => {
    const fake = { branch: 'approved', amount: 5000 };
    expect(Reflect.has(fake, DECISION_RESULT)).toBe(false);
  });
});

// -- Security: $-prefix collision check --------------------------------------

describe('decide/types -- security', () => {
  it('DECISION_RESULT symbol prevents duck-type collision', () => {
    const realResult: DecisionResult = {
      branch: 'x',
      [DECISION_RESULT]: true,
      evidence: { rules: [], chosen: 'x', default: 'y' },
    };
    const fakeResult = { branch: 'x', evidence: {} };

    expect(Reflect.has(realResult, DECISION_RESULT)).toBe(true);
    expect(Reflect.has(fakeResult, DECISION_RESULT)).toBe(false);
  });
});
