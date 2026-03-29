/**
 * Tests for rule error surfacing in decide() / select().
 *
 * Fix: `evaluateRule` previously used `catch {}` (empty catch), silently treating
 * any thrown exception as a non-match. Developers had no way to know their `when`
 * function was throwing — the rule just didn't match and the pipeline continued.
 *
 * Fix adds `matchError?: string` to FunctionRuleEvidence and FilterRuleEvidence.
 * When a `when` function or filter evaluator throws, the error message is captured
 * in `matchError` and `matched` is set to `false`. The rule still does NOT propagate
 * the error (pipelines must be resilient to individual rule failures), but the error
 * is now visible in the evidence for debugging.
 */

import { decide, select } from '../../../../src/lib/decide';
import type { DecideRule } from '../../../../src/lib/decide/types';

// Minimal scope-like object — decide/select only needs to be a plain object
function makeScope(values: Record<string, unknown> = {}): Record<string, unknown> {
  return values;
}

// ---------------------------------------------------------------------------
// Pattern 1: unit — matchError is set when function rule throws
// ---------------------------------------------------------------------------
describe('rule error surfacing — unit: function rule error captured', () => {
  it('function rule that throws has matchError set in evidence', () => {
    const scope = makeScope({ score: 750 });
    const rules: DecideRule<typeof scope>[] = [
      {
        when: (_s) => {
          throw new Error('unexpected null value');
        },
        then: 'branch-a',
        label: 'Broken rule',
      },
    ];

    const result = decide(scope, rules, 'default');

    expect(result.branch).toBe('default'); // default because rule threw
    const ruleEvidence = result.evidence.rules[0];
    expect(ruleEvidence.matched).toBe(false);
    expect(ruleEvidence.matchError).toBe('unexpected null value');
  });

  it('function rule that returns normally has no matchError', () => {
    const scope = makeScope({ score: 750 });
    const rules: DecideRule<typeof scope>[] = [
      {
        when: (s) => (s.score as number) > 700,
        then: 'approved',
      },
    ];

    const result = decide(scope, rules, 'default');

    expect(result.branch).toBe('approved');
    expect(result.evidence.rules[0].matchError).toBeUndefined();
  });

  it('non-Error throws (string, number) are also captured', () => {
    const scope = makeScope();
    const rules: DecideRule<typeof scope>[] = [
      {
        when: () => {
          // eslint-disable-next-line no-throw-literal
          throw 'string-error';
        },
        then: 'x',
      },
      {
        when: () => {
          // eslint-disable-next-line no-throw-literal
          throw 42;
        },
        then: 'y',
      },
    ];

    const result = decide(scope, rules, 'default');

    expect(result.evidence.rules[0].matchError).toBe('string-error');
    expect(result.evidence.rules[1].matchError).toBe('42');
  });
});

// ---------------------------------------------------------------------------
// Pattern 2: boundary — error in one rule doesn't block subsequent rules
// ---------------------------------------------------------------------------
describe('rule error surfacing — boundary: throwing rule does not block evaluation', () => {
  it('error in rule N does not prevent rule N+1 from matching', () => {
    const scope = makeScope({ score: 750 });
    const rules: DecideRule<typeof scope>[] = [
      {
        when: () => {
          throw new Error('rule 0 broken');
        },
        then: 'branch-a',
      },
      {
        when: (s) => (s.score as number) > 700,
        then: 'branch-b',
      },
    ];

    const result = decide(scope, rules, 'default');

    // Rule 0 threw, rule 1 matched — branch-b should win
    expect(result.branch).toBe('branch-b');
    expect(result.evidence.rules[0].matchError).toBe('rule 0 broken');
    expect(result.evidence.rules[1].matched).toBe(true);
    expect(result.evidence.rules[1].matchError).toBeUndefined();
  });

  it('all rules throw — falls back to default with all errors in evidence', () => {
    const scope = makeScope();
    const rules: DecideRule<typeof scope>[] = [
      {
        when: () => {
          throw new Error('err1');
        },
        then: 'a',
      },
      {
        when: () => {
          throw new Error('err2');
        },
        then: 'b',
      },
    ];

    const result = decide(scope, rules, 'fallback');

    expect(result.branch).toBe('fallback');
    expect(result.evidence.rules[0].matchError).toBe('err1');
    expect(result.evidence.rules[1].matchError).toBe('err2');
  });

  it('select() captures errors in all evaluated rules', () => {
    const scope = makeScope({ score: 750 });
    const rules: DecideRule<typeof scope>[] = [
      {
        when: () => {
          throw new Error('select-err');
        },
        then: 'a',
      },
      { when: (s) => (s.score as number) > 700, then: 'b' },
    ];

    const result = select(scope, rules);

    expect(result.branches).toEqual(['b']); // only rule 1 matched
    expect(result.evidence.rules[0].matchError).toBe('select-err');
    expect(result.evidence.rules[1].matched).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pattern 3: scenario — realistic debugging scenario
// ---------------------------------------------------------------------------
describe('rule error surfacing — scenario: debugging a broken rule in a pipeline', () => {
  it('pipeline continues with default when complex rule throws a TypeError', () => {
    const scope = makeScope({ customer: null }); // null — accessing .tier will throw

    const rules: DecideRule<typeof scope>[] = [
      {
        // This rule throws because customer is null
        when: (s) => (s.customer as any).tier === 'premium',
        then: 'premium-path',
        label: 'Premium check',
      },
      {
        when: () => true,
        then: 'default-path',
        label: 'Always match',
      },
    ];

    const result = decide(scope, rules, 'error-path');

    // Rule 0 throws → rule 1 matches
    expect(result.branch).toBe('default-path');

    const erroredRule = result.evidence.rules[0];
    expect(erroredRule.matched).toBe(false);
    expect(erroredRule.matchError).toContain('null');
    expect(erroredRule.label).toBe('Premium check');

    const matchedRule = result.evidence.rules[1];
    expect(matchedRule.matched).toBe(true);
    expect(matchedRule.matchError).toBeUndefined();
  });

  it('evidence can be inspected to find the broken rule after the run', () => {
    const scope = makeScope({ x: 1 });
    const rules: DecideRule<typeof scope>[] = [
      {
        when: () => {
          throw new Error('NullRef in rule 0');
        },
        then: 'a',
        label: 'Rule A',
      },
      { when: () => false, then: 'b', label: 'Rule B' },
    ];

    const result = decide(scope, rules, 'default');
    const brokenRules = result.evidence.rules.filter((r) => r.matchError !== undefined);

    expect(brokenRules.length).toBe(1);
    expect(brokenRules[0].label).toBe('Rule A');
    expect(brokenRules[0].matchError).toBe('NullRef in rule 0');
  });
});

// ---------------------------------------------------------------------------
// Pattern 4: property — matchError is always a string or undefined
// ---------------------------------------------------------------------------
describe('rule error surfacing — property: matchError type invariant', () => {
  it('matchError is undefined for non-throwing rules (regardless of match outcome)', () => {
    const scope = makeScope({ v: 1 });
    const rules: DecideRule<typeof scope>[] = [
      { when: () => false, then: 'a' }, // no throw, no match
      { when: () => true, then: 'b' }, // no throw, matches
    ];

    const result = decide(scope, rules, 'default');

    for (const r of result.evidence.rules) {
      expect(r.matchError).toBeUndefined();
    }
  });

  it('matchError is a string when an Error is thrown', () => {
    const scope = makeScope();
    const rules: DecideRule<typeof scope>[] = [
      {
        when: () => {
          throw new TypeError('type mismatch');
        },
        then: 'x',
      },
    ];

    const result = decide(scope, rules, 'default');
    expect(typeof result.evidence.rules[0].matchError).toBe('string');
  });

  it('matchError is a string when a non-Error value is thrown', () => {
    const scope = makeScope();
    const rules: DecideRule<typeof scope>[] = [
      {
        when: () => {
          // eslint-disable-next-line no-throw-literal
          throw { code: 42, msg: 'object error' };
        },
        then: 'x',
      },
    ];

    const result = decide(scope, rules, 'default');
    // String({ code: 42, msg: 'object error' }) → '[object Object]' — still a string
    expect(typeof result.evidence.rules[0].matchError).toBe('string');
    expect(result.evidence.rules[0].matchError).toBe('[object Object]');
  });
});

// ---------------------------------------------------------------------------
// Pattern 5: security — errors do not leak sensitive scope values
// ---------------------------------------------------------------------------
describe('rule error surfacing — security: error messages do not leak scope values', () => {
  it('TypeError message from accessing null property does not include the value', () => {
    const scope = makeScope({ secret: 'top-secret-value', data: null });

    const rules: DecideRule<typeof scope>[] = [
      {
        when: (s) => {
          // Accessing .length on null throws, but the error message typically
          // says "Cannot read properties of null (reading 'length')" — not the value
          return (s.data as any).length > 0;
        },
        then: 'match',
      },
    ];

    const result = decide(scope, rules, 'default');
    const matchError = result.evidence.rules[0].matchError ?? '';

    // The error message must not contain the actual secret value
    expect(matchError).not.toContain('top-secret-value');
    expect(result.evidence.rules[0].matched).toBe(false);
  });

  it('error message is captured as-is without wrapping or augmenting with scope data', () => {
    const scope = makeScope({ sensitiveKey: 'do-not-include' });
    const errorMsg = 'Rule evaluation failed for business reason';

    const rules: DecideRule<typeof scope>[] = [
      {
        when: () => {
          throw new Error(errorMsg);
        },
        then: 'x',
      },
    ];

    const result = decide(scope, rules, 'default');
    // matchError should be exactly the error message — no scope injection
    expect(result.evidence.rules[0].matchError).toBe(errorMsg);
    expect(result.evidence.rules[0].matchError).not.toContain('sensitiveKey');
    expect(result.evidence.rules[0].matchError).not.toContain('do-not-include');
  });
});

// ---------------------------------------------------------------------------
// Pattern 6: filter path — errors in filter evaluation are surfaced in evidence
// ---------------------------------------------------------------------------
describe('rule error surfacing — filter path: oversized in array captured in matchError', () => {
  it('filter rule with in array > 1000 elements sets matchError and does not match', () => {
    const scope = makeScope({ tier: 'gold' });
    const oversizedArray = Array.from({ length: 1001 }, (_, i) => `tier-${i}`);
    const rules: DecideRule<typeof scope>[] = [
      {
        when: { tier: { in: oversizedArray as string[] } } as any,
        then: 'oversized-branch',
        label: 'Oversized in filter',
      },
    ];

    const result = decide(scope, rules, 'default');

    expect(result.branch).toBe('default'); // oversized array throws → falls back
    const ruleEvidence = result.evidence.rules[0];
    expect(ruleEvidence.matched).toBe(false);
    expect(ruleEvidence.matchError).toContain('1000'); // error mentions the size cap
    expect(ruleEvidence.label).toBe('Oversized in filter');
  });

  it('oversized in array error does not block a subsequent matching rule', () => {
    const scope = makeScope({ tier: 'gold', score: 750 });
    const oversizedArray = Array.from({ length: 1001 }, (_, i) => `tier-${i}`);
    const rules: DecideRule<typeof scope>[] = [
      {
        when: { tier: { in: oversizedArray as string[] } } as any,
        then: 'oversized-branch',
      },
      {
        // Function rule reads directly from the plain object — no getValue needed
        when: (s) => (s.score as number) > 700,
        then: 'good-score',
      },
    ];

    const result = decide(scope, rules, 'default');

    // First rule threw, second rule matched
    expect(result.branch).toBe('good-score');
    expect(result.evidence.rules[0].matchError).toBeDefined();
    expect(result.evidence.rules[1].matched).toBe(true);
    expect(result.evidence.rules[1].matchError).toBeUndefined();
  });
});
