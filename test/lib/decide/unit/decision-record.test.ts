/**
 * `decisionRecord` and `fixedRecord` (decide/record.ts) — the decision record as a projection of `DecisionEvidence`,
 * and the one record no evidence can give.
 *
 * Test types: Unit (every evidence shape: a filter or function rule won, with and without a label, an empty one
 * included; the default with and without a label; no rows at all; a rule whose branch equals the default; retry
 * evidence) · Boundary (`reads` de-duplicated in first-read order; the cases that lose a name; a function rule that
 * threw keeps its names; `fixedRecord`'s refusals).
 */
import { describe, expect, it } from 'vitest';

import type { DecideRule, DecisionEvidence } from '../../../../src/index.js';
import { decideFromFacts, decisionRecord, fixedRecord } from '../../../../src/index.js';
import { decideAttempt, retryRules } from '../../../../src/lib/attempt/decision.js';

type Facts = Record<string, unknown>;

const recordOf = (rules: DecideRule<Facts>[], facts: Facts, fallback: Parameters<typeof decideFromFacts>[2]) =>
  decisionRecord(decideFromFacts(rules, facts, fallback).evidence);

describe('decisionRecord — a rule won', () => {
  it('a filter rule: its index, its label, the names its conditions read — in that key order', () => {
    const record = recordOf(
      [
        { when: { express: { eq: true } }, then: 'courier', label: 'Express' },
        { when: { weightKg: { gt: 30 }, oversize: { eq: true } }, then: 'freight', label: 'Too big for a parcel' },
      ],
      { express: false, weightKg: 40, oversize: true },
      'post',
    );
    expect(record).toEqual({
      strategy: 'freight',
      by: 'rule',
      rule: 1,
      label: 'Too big for a parcel',
      reads: ['weightKg', 'oversize'],
    });
    expect(Object.keys(record)).toEqual(['strategy', 'by', 'rule', 'label', 'reads']);
  });

  it('a function rule: the names it read, each once, in first-read order', () => {
    const record = recordOf(
      [{ when: (f) => [f.b, f.a, f.b].join() === '2,1,2', then: 'x', label: 'both' }],
      { a: 1, b: 2 },
      'post',
    );
    expect(record).toEqual({ strategy: 'x', by: 'rule', rule: 0, label: 'both', reads: ['b', 'a'] });
  });

  it('a filter key with two operators is one name', () => {
    expect(recordOf([{ when: { n: { gt: 1, lt: 9 } }, then: 'mid' }], { n: 5 }, 'post').reads).toEqual(['n']);
  });

  it('a rule with no label: no label key', () => {
    const record = recordOf([{ when: { n: { eq: 1 } }, then: 'one' }], { n: 1 }, { branch: 'post', label: 'Default' });
    expect(record).toEqual({ strategy: 'one', by: 'rule', rule: 0, reads: ['n'] });
    expect(record).not.toHaveProperty('label');
  });

  it('an empty-string label is a label the author wrote: kept as written, for a rule and for the default', () => {
    expect(recordOf([{ when: { n: { eq: 1 } }, then: 'one', label: '' }], { n: 1 }, 'post')).toEqual({
      strategy: 'one',
      by: 'rule',
      rule: 0,
      label: '',
      reads: ['n'],
    });
    expect(recordOf([], {}, { branch: 'post', label: '' })).toEqual({
      strategy: 'post',
      by: 'default',
      label: '',
      reads: [],
    });
    expect(fixedRecord('post', '')).toEqual({ strategy: 'post', by: 'fixed', label: '', reads: [] });
  });

  it("a rule whose branch is the default's is still by: 'rule' — never inferred from chosen === default", () => {
    const record = recordOf([{ when: { n: { eq: 1 } }, then: 'post', label: 'Standard' }], { n: 1 }, 'post');
    expect(record).toMatchObject({ strategy: 'post', by: 'rule', rule: 0, label: 'Standard' });
  });

  it('reads only the winning row, not the rows before it', () => {
    const record = recordOf(
      [
        { when: { a: { eq: 1 } }, then: 'x' },
        { when: (f) => f.b === 2, then: 'y' },
      ],
      { a: 0, b: 2 },
      'post',
    );
    expect(record).toEqual({ strategy: 'y', by: 'rule', rule: 1, reads: ['b'] });
  });
});

describe('decisionRecord — the default', () => {
  const rules: DecideRule<Facts>[] = [
    { when: { a: { eq: 1 }, b: { eq: 1 } }, then: 'x' },
    { when: (f) => f.c === 1 || f.a === 1, then: 'y' },
  ];

  it('with a label: by default, the label, and every name any rule read, de-duplicated in first-read order', () => {
    const record = recordOf(rules, { a: 0, b: 0, c: 0 }, { branch: 'post', label: 'No rule fired' });
    expect(record).toEqual({ strategy: 'post', by: 'default', label: 'No rule fired', reads: ['a', 'b', 'c'] });
    expect(Object.keys(record)).toEqual(['strategy', 'by', 'label', 'reads']);
  });

  it('without a label: no label key, no rule key', () => {
    const record = recordOf(rules, { a: 0, b: 0, c: 0 }, 'post');
    expect(record).toEqual({ strategy: 'post', by: 'default', reads: ['a', 'b', 'c'] });
  });

  it('no rows at all: an empty table reads nothing', () => {
    expect(recordOf([], { a: 1 }, 'post')).toEqual({ strategy: 'post', by: 'default', reads: [] });
  });

  it('a JS caller with no default still gets a record of what was evaluated', () => {
    const evidence = decideFromFacts([{ when: { a: { eq: 1 } }, then: 'x' }], { a: 0 }, undefined as never).evidence;
    expect(decisionRecord(evidence)).toEqual({ strategy: undefined, by: 'default', reads: ['a'] });
  });
});

describe('decisionRecord — the names it cannot give, and the ones it keeps', () => {
  it('a filter rule that threw contributes no names', () => {
    const record = recordOf(
      [
        { when: { big: { in: Array.from({ length: 1001 }, (_, i) => i) } }, then: 'x' },
        { when: { small: { eq: 1 } }, then: 'y' },
      ],
      { big: 1, small: 0 },
      'post',
    );
    expect(record).toEqual({ strategy: 'post', by: 'default', reads: ['small'] });
  });

  it('a denylisted key records no condition, so no name', () => {
    const record = recordOf(
      [{ when: { constructor: { ne: null }, a: { eq: 1 } } as never, then: 'x' }],
      { a: 1 },
      'post',
    );
    expect(record).toEqual({ strategy: 'post', by: 'default', reads: ['a'] });
  });

  it('a key with an empty operator object is read but records no condition, so no name', () => {
    const record = recordOf([{ when: { a: {}, b: { eq: 1 } }, then: 'x' }], { a: 1, b: 0 }, 'post');
    expect(record).toEqual({ strategy: 'post', by: 'default', reads: ['b'] });
  });

  it("a function rule's symbol-keyed read is not a name", () => {
    const tag = Symbol('tag');
    const record = recordOf([{ when: (f) => (f as never)[tag] === 1 || f.a === 1, then: 'x' }], { a: 1 }, 'post');
    expect(record).toEqual({ strategy: 'x', by: 'rule', rule: 0, reads: ['a'] });
  });

  it('a function rule that threw keeps the names it read before the throw', () => {
    const record = recordOf(
      [
        {
          when: (f) => {
            if (f.a === 1) throw new Error('no');
            return f.b === 1;
          },
          then: 'x',
        },
      ],
      { a: 1, b: 1 },
      'post',
    );
    expect(record).toEqual({ strategy: 'post', by: 'default', reads: ['a'] });
  });
});

describe('decisionRecord — evidence from the other doors', () => {
  it("decide()'s evidence shape, written by hand: the last row's matched decides", () => {
    const evidence: DecisionEvidence = {
      rules: [
        { type: 'filter', ruleIndex: 0, branch: 'x', matched: false, conditions: [] },
        {
          type: 'function',
          ruleIndex: 1,
          branch: 'y',
          matched: true,
          label: 'Y',
          inputs: [{ key: 'k', valueSummary: '1', redacted: false }],
        },
      ],
      chosen: 'y',
      default: 'z',
      defaultLabel: 'Z',
    };
    expect(decisionRecord(evidence)).toEqual({ strategy: 'y', by: 'rule', rule: 1, label: 'Y', reads: ['k'] });
  });

  it('a retry decision: its label is its reason', () => {
    const inputs: Record<string, unknown> = { outcome: 'failed', aborted: false, attempt: 3, of: 3 };
    const { evidence } = decideAttempt(retryRules({ attempts: 3 }), (key) => inputs[key]);
    expect(decisionRecord(evidence)).toEqual({
      strategy: 'stop',
      by: 'rule',
      rule: 3,
      label: 'exhausted',
      reads: ['attempt'],
    });
  });

  it('the record is a new object: editing it changes neither the evidence nor the next record', () => {
    const { evidence } = decideFromFacts([{ when: { a: { eq: 1 } }, then: 'x' }], { a: 1 }, 'post');
    const record = decisionRecord(evidence);
    (record.reads as string[]).push('later');
    expect(evidence.rules[0]).toMatchObject({ conditions: [{ key: 'a' }] });
    expect(decisionRecord(evidence).reads).toEqual(['a']);
  });
});

describe('fixedRecord — a choice no table made', () => {
  it('a bare string in a configuration', () => {
    const record = fixedRecord('courier', undefined, 'app');
    expect(record).toEqual({ strategy: 'courier', by: 'fixed', reads: [], voucher: 'app' });
    expect(Object.keys(record)).toEqual(['strategy', 'by', 'reads', 'voucher']);
  });

  it('with a label and a provider voucher; with neither', () => {
    expect(fixedRecord('courier', 'Set by the adapter', 'provider')).toEqual({
      strategy: 'courier',
      by: 'fixed',
      label: 'Set by the adapter',
      reads: [],
      voucher: 'provider',
    });
    const bare = fixedRecord('courier');
    expect(bare).toEqual({ strategy: 'courier', by: 'fixed', reads: [] });
    expect(bare).not.toHaveProperty('rule');
    expect(bare).not.toHaveProperty('voucher');
  });

  it('refuses what is not a strategy, a label or one of the two vouchers', () => {
    expect(() => fixedRecord(undefined as never)).toThrow(/strategy must be a string/);
    expect(() => fixedRecord('courier', 3 as never)).toThrow(/label must be a string/);
    expect(() => fixedRecord('courier', undefined, 'person' as never)).toThrow(/voucher must be 'app' or 'provider'/);
    expect(() => fixedRecord('courier', undefined, 'rule' as never)).toThrow(TypeError);
  });
});
