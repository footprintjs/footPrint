/**
 * `filter/firstMatch.ts` — the ONE first-match loop `decide()`, `decideAttempt` and `decideFromFacts` share, and one
 * rule's evaluation without a scope.
 *
 * Test types: Unit (the loop stops at the first match and builds the evidence in decide()'s key order; the label it
 * hands back; both default forms; `ruleOver` with no keeping, with mask-all, with a run's answers) · Boundary (a
 * missing default passes through, as a JS caller of decide() has always had it; a malformed mask is refused at once).
 */
import { describe, expect, it } from 'vitest';

import type { RuleEvidence } from '../../../../src/lib/decide/types.js';
import { firstMatch, keepingOf, normalizeDefaultBranch, ruleOver } from '../../../../src/lib/filter/firstMatch.js';

const rule = (then: string, label?: string) => ({ then, ...(label === undefined ? {} : { label }) });

/** A stub evaluator: matches the rules named in `winners`, and records each call. */
function stub(winners: readonly number[]) {
  const asked: number[] = [];
  const evaluate = (r: { then: string; label?: string }, index: number): RuleEvidence => {
    asked.push(index);
    return {
      type: 'filter',
      ruleIndex: index,
      branch: r.then,
      matched: winners.includes(index),
      label: r.label,
      conditions: [],
    };
  };
  return { asked, evaluate };
}

describe('firstMatch — the loop', () => {
  it('stops at the first match; the evidence holds the rows so far, in key order rules, chosen, default', () => {
    const { asked, evaluate } = stub([1, 2]);
    const pass = firstMatch([rule('a'), rule('b', 'Bee'), rule('c')], evaluate, { branch: 'd' });
    expect(asked).toEqual([0, 1]);
    expect(pass.branch).toBe('b');
    expect(pass.label).toBe('Bee');
    expect(Object.keys(pass.evidence)).toEqual(['rules', 'chosen', 'default']);
    expect(pass.evidence.rules.map((row) => row.ruleIndex)).toEqual([0, 1]);
    expect(pass.evidence.chosen).toBe('b');
  });

  it("no match: the default, with the default's label, on both exits when it has one", () => {
    const fell = firstMatch([rule('a')], stub([]).evaluate, { branch: 'd', label: 'Dee' });
    expect(fell).toMatchObject({ branch: 'd', label: 'Dee' });
    expect(Object.keys(fell.evidence)).toEqual(['rules', 'chosen', 'default', 'defaultLabel']);
    const won = firstMatch([rule('a')], stub([0]).evaluate, { branch: 'd', label: 'Dee' });
    expect(won.evidence.defaultLabel).toBe('Dee');
    expect(won.label).toBeUndefined();
  });

  it('an empty table asks nothing and chooses the default', () => {
    const { asked, evaluate } = stub([0]);
    expect(firstMatch([], evaluate, { branch: 'd' }).evidence).toEqual({ rules: [], chosen: 'd', default: 'd' });
    expect(asked).toEqual([]);
  });
});

describe('normalizeDefaultBranch', () => {
  it('a string is the branch; the object form is itself; anything else passes through untouched', () => {
    expect(normalizeDefaultBranch('d')).toEqual({ branch: 'd' });
    const object = { branch: 'd', label: 'Dee' };
    expect(normalizeDefaultBranch(object)).toBe(object);
    expect(normalizeDefaultBranch(undefined as never)).toEqual({ branch: undefined });
  });
});

describe('ruleOver — one rule without a scope', () => {
  const values: Record<string, unknown> = { n: 5, s: 'five' };
  const read = (key: string) => values[key];

  it('no mask: every value as it is', () => {
    const evaluate = ruleOver(read);
    expect(evaluate({ when: { n: { gt: 1 } }, then: 'x' }, 0)).toMatchObject({
      conditions: [{ key: 'n', threshold: 1, actualSummary: '5', redacted: false }],
    });
    expect(evaluate({ when: (v: Record<string, unknown>) => v.s === 'five', then: 'x' }, 1)).toMatchObject({
      inputs: [{ key: 's', valueSummary: '"five"', redacted: false }],
    });
  });

  it("'all': names and operators only", () => {
    const evaluate = ruleOver(read, keepingOf('all'));
    expect(evaluate({ when: { n: { gt: 1 } }, then: 'x' }, 0)).toMatchObject({
      matched: true,
      conditions: [
        {
          key: 'n',
          op: 'gt',
          threshold: '[REDACTED]',
          thresholdRedacted: true,
          actualSummary: '[REDACTED]',
          redacted: true,
        },
      ],
    });
    expect(evaluate({ when: (v: Record<string, unknown>) => v.s === 'five', then: 'x' }, 1)).toMatchObject({
      matched: true,
      inputs: [{ key: 's', valueSummary: '[REDACTED]', redacted: true }],
    });
  });

  it("a run's answers: asked per key, the threshold served by them, the thrown text served by them", () => {
    const asked: string[] = [];
    const evaluate = ruleOver(
      read,
      keepingOf({
        masksActual: (key) => {
          asked.push(key);
          return key === 's';
        },
        serveThreshold: (_key, threshold) => ({ threshold: `served ${String(threshold)}` }),
        servedMatchError: (text) => `served: ${text}`,
      }),
    );
    expect(evaluate({ when: { n: { gt: 1 } }, then: 'x' }, 0)).toMatchObject({
      conditions: [{ key: 'n', threshold: 'served 1', actualSummary: '5', redacted: false }],
    });
    const thrown = evaluate(
      {
        when: (v: Record<string, unknown>) => {
          throw new Error(`saw ${String(v.s)}`);
        },
        then: 'x',
      },
      1,
    );
    expect(thrown).toMatchObject({
      inputs: [{ key: 's', valueSummary: '[REDACTED]', redacted: true }],
      matchError: 'served: saw five',
    });
    expect(asked).toEqual(['n', 's']);
  });

  it('a malformed mask is refused when its keeping is made', () => {
    expect(() => keepingOf('none' as never)).toThrow(TypeError);
    expect(() => keepingOf({ masksActual: () => false } as never)).toThrow(TypeError);
    expect(() => keepingOf(undefined as never)).toThrow(TypeError);
  });
});
