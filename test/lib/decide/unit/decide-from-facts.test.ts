/**
 * `decideFromFacts` — `decide()`'s evaluation without a scope (decide/fromFacts.ts, on filter/firstMatch.ts).
 *
 * Test types: Unit (first match wins; the default with and without a label; a throwing rule is recorded as not
 * matched, as in `decide()`; the mask's three forms) · Boundary (an empty table, facts read lazily and only as own
 * properties, a prototype-named rule key, a malformed call).
 */
import { describe, expect, it } from 'vitest';

import type { DecideRule } from '../../../../src/index.js';
import { decideFromFacts } from '../../../../src/index.js';
import { RedactionRule } from '../../../../src/lib/memory/redaction.js';

type Facts = Record<string, unknown>;

/** The answers a run with no redaction policy gives `decide()`: every value kept. */
const KEEP = { mask: new RedactionRule().evidenceRule(() => ({})) };

const SHIPPING: DecideRule<Facts>[] = [
  { when: { express: { eq: true } }, then: 'courier', label: 'Express delivery was asked for' },
  { when: (f) => (f.weightKg as number) > 30, then: 'freight', label: 'Too heavy for a parcel' },
];

describe('decideFromFacts — first match wins', () => {
  it('the first matching rule chooses; later rules are not evaluated', () => {
    const { branch, evidence } = decideFromFacts(SHIPPING, { express: true, weightKg: 40 }, 'post', KEEP);
    expect(branch).toBe('courier');
    expect(evidence).toEqual({
      rules: [
        {
          type: 'filter',
          ruleIndex: 0,
          branch: 'courier',
          matched: true,
          label: 'Express delivery was asked for',
          conditions: [
            { key: 'express', op: 'eq', threshold: true, actualSummary: 'true', result: true, redacted: false },
          ],
        },
      ],
      chosen: 'courier',
      default: 'post',
    });
  });

  it('a later rule chooses when the earlier ones do not match; a function rule records what it read', () => {
    const { branch, evidence } = decideFromFacts(SHIPPING, { express: false, weightKg: 40 }, 'post', KEEP);
    expect(branch).toBe('freight');
    expect(evidence.rules.map((row) => [row.ruleIndex, row.matched])).toEqual([
      [0, false],
      [1, true],
    ]);
    expect(evidence.rules[1]).toMatchObject({
      type: 'function',
      inputs: [{ key: 'weightKg', valueSummary: '40', redacted: false }],
    });
  });

  it('a rule whose branch equals the default still chooses as a rule', () => {
    const rules: DecideRule<Facts>[] = [{ when: { express: { eq: false } }, then: 'post', label: 'Standard' }];
    const { evidence } = decideFromFacts(rules, { express: false }, 'post', KEEP);
    expect(evidence.rules[0].matched).toBe(true);
    expect(evidence.chosen).toBe('post');
  });
});

describe('decideFromFacts — the default', () => {
  it('a bare string: no defaultLabel key at all, as decide() records it', () => {
    const { branch, evidence } = decideFromFacts(SHIPPING, { express: false, weightKg: 2 }, 'post', KEEP);
    expect(branch).toBe('post');
    expect(evidence.chosen).toBe('post');
    expect(evidence.default).toBe('post');
    expect(Object.keys(evidence)).toEqual(['rules', 'chosen', 'default']);
  });

  it('with a label: defaultLabel on the fallthrough and on a decision a rule won', () => {
    const fallback = { branch: 'post', label: 'No rule fired' };
    const fell = decideFromFacts(SHIPPING, { express: false, weightKg: 2 }, fallback).evidence;
    const won = decideFromFacts(SHIPPING, { express: true }, fallback).evidence;
    expect(Object.keys(fell)).toEqual(['rules', 'chosen', 'default', 'defaultLabel']);
    expect(fell.defaultLabel).toBe('No rule fired');
    expect(won.chosen).toBe('courier');
    expect(won.defaultLabel).toBe('No rule fired');
  });

  it('an object default with no label records none', () => {
    const { evidence } = decideFromFacts(SHIPPING, {}, { branch: 'post' });
    expect(evidence).not.toHaveProperty('defaultLabel');
  });

  it('an empty filter never matches: the catch-all is the default', () => {
    const { branch, evidence } = decideFromFacts([{ when: {}, then: 'always' }], { a: 1 }, 'post');
    expect(branch).toBe('post');
    expect(evidence.rules[0]).toMatchObject({ matched: false, conditions: [] });
  });
});

describe('decideFromFacts — a rule that throws, as in decide()', () => {
  const throwing: DecideRule<Facts>[] = [
    {
      when: (f) => {
        if (f.weightKg !== undefined) throw new Error(`scale read ${String(f.weightKg)}`);
        return true;
      },
      then: 'freight',
      label: 'Heavy',
    },
    { when: { express: { eq: true } }, then: 'courier' },
  ];

  it('is recorded as not matched, keeps its reads, and evaluation goes on', () => {
    const { branch, evidence } = decideFromFacts(throwing, { weightKg: 40, express: true }, 'post', KEEP);
    expect(branch).toBe('courier');
    expect(evidence.rules[0]).toEqual({
      type: 'function',
      ruleIndex: 0,
      branch: 'freight',
      matched: false,
      label: 'Heavy',
      inputs: [
        { key: 'weightKg', valueSummary: '40', redacted: false },
        { key: 'weightKg', valueSummary: '40', redacted: false },
      ],
      matchError: 'scale read 40',
    });
  });

  it("under the default mask its text is the placeholder, and the thrown value's own code never runs", () => {
    let asked = 0;
    const thrown = {
      toString() {
        asked += 1;
        return 'never asked';
      },
    };
    const rules: DecideRule<Facts>[] = [
      {
        when: () => {
          throw thrown;
        },
        then: 'x',
      },
    ];
    const { evidence } = decideFromFacts(rules, {}, 'post');
    expect(evidence.rules[0]).toMatchObject({ matched: false, matchError: '[REDACTED]' });
    expect(asked).toBe(0);
    // With a run's rule the text is quoted, as decide() quotes it.
    expect(decideFromFacts(rules, {}, 'post', KEEP).evidence.rules[0].matchError).toBe('never asked');
    expect(asked).toBe(1);
  });

  it('a filter rule that throws records the error and no conditions', () => {
    const rules: DecideRule<Facts>[] = [{ when: { n: { in: Array.from({ length: 1001 }, (_, i) => i) } }, then: 'x' }];
    const { evidence } = decideFromFacts(rules, { n: 1 }, 'post', KEEP);
    expect(evidence.rules[0]).toMatchObject({
      matched: false,
      conditions: [],
      matchError: 'in/notIn array exceeds maximum size of 1000',
    });
  });
});

describe('decideFromFacts — the mask', () => {
  it("the default keeps names and operators only — the same as { mask: 'all' }", () => {
    const facts = { express: false, weightKg: 40 };
    const masked = decideFromFacts(SHIPPING, facts, 'post');
    expect(masked).toEqual(decideFromFacts(SHIPPING, facts, 'post', { mask: 'all' }));
    expect(masked.branch).toBe('freight');
    expect(masked.evidence.rules[0]).toMatchObject({
      conditions: [
        {
          key: 'express',
          op: 'eq',
          threshold: '[REDACTED]',
          thresholdRedacted: true,
          actualSummary: '[REDACTED]',
          result: false,
          redacted: true,
        },
      ],
    });
    expect(masked.evidence.rules[1]).toMatchObject({
      inputs: [{ key: 'weightKg', valueSummary: '[REDACTED]', redacted: true }],
    });
  });

  it('the values still decide: the mask hides them in the evidence only', () => {
    expect(decideFromFacts(SHIPPING, { express: true }, 'post').branch).toBe('courier');
    expect(decideFromFacts(SHIPPING, { weightKg: 31 }, 'post').branch).toBe('freight');
    expect(decideFromFacts(SHIPPING, { weightKg: 30 }, 'post').branch).toBe('post');
  });

  it("a run's rule masks what it selects, by name, and keeps the rest", () => {
    const mask = new RedactionRule({ keys: ['weightKg'] }).evidenceRule(() => ({}));
    const { evidence } = decideFromFacts(SHIPPING, { express: false, weightKg: 40 }, 'post', { mask });
    expect(evidence.rules[0]).toMatchObject({
      conditions: [{ key: 'express', threshold: true, actualSummary: 'false', redacted: false }],
    });
    expect(evidence.rules[1]).toMatchObject({
      inputs: [{ key: 'weightKg', valueSummary: '[REDACTED]', redacted: true }],
    });
  });

  it('a malformed mask is refused before any rule runs', () => {
    let ran = 0;
    const rules: DecideRule<Facts>[] = [{ when: () => (ran += 1) > 0, then: 'x' }];
    for (const mask of ['none', {}, { masksActual: () => true }, 0]) {
      expect(() => decideFromFacts(rules, {}, 'post', { mask: mask as never })).toThrow(TypeError);
    }
    expect(ran).toBe(0);
  });

  it('a mask of null or undefined is the default: nothing is kept', () => {
    const facts = { express: true };
    const masked = decideFromFacts(SHIPPING, facts, 'post');
    expect(decideFromFacts(SHIPPING, facts, 'post', { mask: null as never })).toEqual(masked);
    expect(decideFromFacts(SHIPPING, facts, 'post', { mask: undefined })).toEqual(masked);
    expect(decideFromFacts(SHIPPING, facts, 'post', {})).toEqual(masked);
  });
});

describe('decideFromFacts — boundaries', () => {
  it('an empty table chooses the default and records no rows', () => {
    expect(decideFromFacts([], { a: 1 }, 'post').evidence).toEqual({ rules: [], chosen: 'post', default: 'post' });
  });

  it('reads a fact only when a rule reaches it, in rule order', () => {
    const asked: string[] = [];
    const facts = new Proxy({ a: 1, b: 2, c: 3 } as Facts, {
      get(target, key) {
        if (typeof key === 'string') asked.push(key);
        return Reflect.get(target, key);
      },
    });
    const rules: DecideRule<Facts>[] = [
      { when: { b: { eq: 2 } }, then: 'x' },
      { when: { c: { eq: 3 } }, then: 'y' },
    ];
    expect(decideFromFacts(rules, facts, 'post').branch).toBe('x');
    expect(asked).toEqual(['b']);
  });

  it('reads own properties only: an inherited name is a missing fact', () => {
    const facts = Object.create({ express: true }) as Facts;
    const viaFilter = decideFromFacts([{ when: { express: { eq: true } }, then: 'courier' }], facts, 'post', KEEP);
    expect(viaFilter.branch).toBe('post');
    expect(viaFilter.evidence.rules[0]).toMatchObject({ conditions: [{ actualSummary: 'undefined' }] });
    const viaFunction = decideFromFacts([{ when: (f) => f.toLocaleString !== undefined, then: 'x' }], {}, 'post');
    expect(viaFunction.branch).toBe('post');
  });

  it('a prototype-named filter key fails its rule and records no condition', () => {
    const { evidence } = decideFromFacts([{ when: { constructor: { ne: null } } as never, then: 'x' }], {}, 'post');
    expect(evidence.rules[0]).toMatchObject({ matched: false, conditions: [] });
  });

  it('accepts a readonly table', () => {
    const rules: readonly DecideRule<{ n: number }>[] = Object.freeze([{ when: { n: { gt: 1 } }, then: 'big' }]);
    expect(decideFromFacts(rules, { n: 2 }, 'small').branch).toBe('big');
  });

  it('refuses facts that are not an object', () => {
    for (const facts of [undefined, null, 'express', 3]) {
      expect(() => decideFromFacts(SHIPPING, facts as never, 'post')).toThrow(/facts must be an object/);
    }
  });
});
