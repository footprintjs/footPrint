/**
 * `filter/firstMatch.ts` — the ONE first-match loop `decide()`, `decideAttempt` and `decideFromFacts` share, the ONE row
 * assembler, and one rule's evaluation without a scope.
 *
 * Test types: Unit (the loop stops at the first match and builds the evidence in decide()'s key order; the label it
 * hands back; both default forms; `ruleOver` keeping every value and none; the row builders) · Boundary (a missing
 * default passes through, as a JS caller of decide() has always had it; a function rule's return is never stored; a
 * view held past its rule is closed; a symbol read is not recorded).
 */
import { describe, expect, it } from 'vitest';

import type { RuleEvidence } from '../../../../src/lib/decide/types.js';
import {
  filterRow,
  firstMatch,
  functionRow,
  KEEP_NO_VALUE,
  normalizeDefaultBranch,
  ruleOver,
} from '../../../../src/lib/filter/firstMatch.js';

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

  it('every value kept (the default): values as they are', () => {
    const evaluate = ruleOver(read);
    expect(evaluate({ when: { n: { gt: 1 } }, then: 'x' }, 0)).toMatchObject({
      conditions: [{ key: 'n', threshold: 1, actualSummary: '5', redacted: false }],
    });
    expect(evaluate({ when: (v: Record<string, unknown>) => v.s === 'five', then: 'x' }, 1)).toMatchObject({
      inputs: [{ key: 's', valueSummary: '"five"', redacted: false }],
    });
  });

  it('no value kept: names and operators only, and a thrown text is the placeholder', () => {
    const evaluate = ruleOver(read, KEEP_NO_VALUE);
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
    const thrower = (v: Record<string, unknown>): boolean => {
      throw new Error(`saw ${String(v.s)}`);
    };
    expect(evaluate({ when: thrower, then: 'x' }, 2)).toMatchObject({ matched: false, matchError: '[REDACTED]' });
    expect(ruleOver(read)({ when: thrower, then: 'x' }, 2)).toMatchObject({ matchError: 'saw five' });
  });

  it("a function rule's return is never stored: matched is its truthiness", () => {
    const evaluate = ruleOver(read);
    const returning = (value: unknown) => ({ when: () => value as boolean, then: 'x' });
    expect(evaluate(returning('five'), 0).matched).toBe(true);
    expect(evaluate(returning(0), 0).matched).toBe(false);
    expect(evaluate(returning(undefined), 0).matched).toBe(false);
    expect(evaluate(returning({ secret: 1 }), 0).matched).toBe(true);
  });

  it('a view kept past its rule reads nothing and adds nothing to the row', () => {
    let kept: Record<string, unknown> | undefined;
    const row = ruleOver(read)(
      {
        when: (v: Record<string, unknown>) => {
          kept = v;
          return v.n === 5;
        },
        then: 'x',
      },
      0,
    );
    expect(kept?.s).toBeUndefined();
    expect(row).toMatchObject({ matched: true, inputs: [{ key: 'n' }] });
    expect((row as { inputs: unknown[] }).inputs).toHaveLength(1);
  });

  it('a symbol-keyed read answers undefined and is not recorded, so the row stays cloneable', () => {
    const tag = Symbol('tag');
    const row = ruleOver(read)(
      { when: (v: Record<string | symbol, unknown>) => v[tag] === undefined && v.n === 5, then: 'x' },
      0,
    );
    expect(row).toMatchObject({ matched: true, inputs: [{ key: 'n' }] });
    expect((row as { inputs: unknown[] }).inputs).toHaveLength(1);
    expect(structuredClone(row)).toEqual(row);
  });
});

describe('the row builders — one assembler for every door', () => {
  it('functionRow: key order, the label kept as written, matched a boolean', () => {
    const row = functionRow({ then: 'x', label: '' }, 3, 'value', [], 'boom');
    expect(row).toEqual({
      type: 'function',
      ruleIndex: 3,
      branch: 'x',
      matched: true,
      label: '',
      inputs: [],
      matchError: 'boom',
    });
    expect(Object.keys(row)).toEqual(['type', 'ruleIndex', 'branch', 'matched', 'label', 'inputs', 'matchError']);
  });

  it('filterRow: no matchError key unless one was given', () => {
    const row = filterRow({ then: 'x' }, 0, false, [], undefined);
    expect(Object.keys(row)).toEqual(['type', 'ruleIndex', 'branch', 'matched', 'label', 'conditions']);
  });
});
