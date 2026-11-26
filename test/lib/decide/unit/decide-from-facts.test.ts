/**
 * `decideFromFacts` — `decide()`'s evaluation without a scope (decide/fromFacts.ts, on filter/firstMatch.ts).
 *
 * Test types: Unit (first match wins; the default with and without a label; a throwing rule is recorded as not
 * matched, as in `decide()`; the evidence keeps names and operators only, and no argument can make it keep a value) ·
 * Boundary (an empty table; facts read once, up front, as own DATA properties; a prototype-named rule key; a kept view;
 * a non-boolean return; a `null` default, pinned for both doors) · Security (refused up front, naming no value: an own
 * accessor, a stage scope, a Map or a Set, and facts that are not an object).
 */
import { describe, expect, it } from 'vitest';

import type { DecideRule } from '../../../../src/index.js';
import { decide, decideFromFacts, flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { RedactionRule } from '../../../../src/lib/memory/redaction.js';
import { registerTestScope } from '../../../helpers/registerScope';

type Facts = Record<string, unknown>;

const SHIPPING: DecideRule<Facts>[] = [
  { when: { express: { eq: true } }, then: 'courier', label: 'Express delivery was asked for' },
  { when: (f) => (f.weightKg as number) > 30, then: 'freight', label: 'Too heavy for a parcel' },
];

describe('decideFromFacts — first match wins', () => {
  it('the first matching rule chooses; later rules are not evaluated; values are masked', () => {
    const { branch, evidence } = decideFromFacts(SHIPPING, { express: true, weightKg: 40 }, 'post');
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
            {
              key: 'express',
              op: 'eq',
              threshold: '[REDACTED]',
              actualSummary: '[REDACTED]',
              result: true,
              redacted: true,
              thresholdRedacted: true,
            },
          ],
        },
      ],
      chosen: 'courier',
      default: 'post',
    });
  });

  it('a later rule chooses when the earlier ones do not match; a function rule records the name it read', () => {
    const { branch, evidence } = decideFromFacts(SHIPPING, { express: false, weightKg: 40 }, 'post');
    expect(branch).toBe('freight');
    expect(evidence.rules.map((row) => [row.ruleIndex, row.matched])).toEqual([
      [0, false],
      [1, true],
    ]);
    expect(evidence.rules[1]).toMatchObject({
      type: 'function',
      inputs: [{ key: 'weightKg', valueSummary: '[REDACTED]', redacted: true }],
    });
  });

  it('a rule whose branch equals the default still chooses as a rule', () => {
    const rules: DecideRule<Facts>[] = [{ when: { express: { eq: false } }, then: 'post', label: 'Standard' }];
    const { evidence } = decideFromFacts(rules, { express: false }, 'post');
    expect(evidence.rules[0].matched).toBe(true);
    expect(evidence.chosen).toBe('post');
  });

  it('the values still decide: the mask hides them in the evidence only', () => {
    expect(decideFromFacts(SHIPPING, { express: true }, 'post').branch).toBe('courier');
    expect(decideFromFacts(SHIPPING, { weightKg: 31 }, 'post').branch).toBe('freight');
    expect(decideFromFacts(SHIPPING, { weightKg: 30 }, 'post').branch).toBe('post');
  });
});

describe('decideFromFacts — the default', () => {
  it('a bare string: no defaultLabel key at all, as decide() records it', () => {
    const { branch, evidence } = decideFromFacts(SHIPPING, { express: false, weightKg: 2 }, 'post');
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

  it('a null default passes through as the branch, on both doors, as decide() has always had it', () => {
    const rules: DecideRule<Facts>[] = [{ when: { a: { eq: 1 } }, then: 'x' }];
    const fromFacts = decideFromFacts(rules, { a: 0 }, null as never);
    const fromScope = decide(registerTestScope({ a: 0 }), rules, null as never);
    for (const { branch, evidence } of [fromFacts, fromScope]) {
      expect(branch).toBeNull();
      expect(evidence.chosen).toBeNull();
      expect(evidence.default).toBeNull();
      expect(evidence).not.toHaveProperty('defaultLabel');
    }
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

  it('is recorded as not matched, keeps its reads, says why in the placeholder, and evaluation goes on', () => {
    const { branch, evidence } = decideFromFacts(throwing, { weightKg: 40, express: true }, 'post');
    expect(branch).toBe('courier');
    expect(evidence.rules[0]).toEqual({
      type: 'function',
      ruleIndex: 0,
      branch: 'freight',
      matched: false,
      label: 'Heavy',
      inputs: [
        { key: 'weightKg', valueSummary: '[REDACTED]', redacted: true },
        { key: 'weightKg', valueSummary: '[REDACTED]', redacted: true },
      ],
      matchError: '[REDACTED]',
    });
  });

  it("the thrown value's own code never runs", () => {
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
    expect(decideFromFacts(rules, {}, 'post').evidence.rules[0]).toMatchObject({
      matched: false,
      matchError: '[REDACTED]',
    });
    expect(asked).toBe(0);
  });

  it('a filter rule that throws records the placeholder and no conditions', () => {
    const rules: DecideRule<Facts>[] = [{ when: { n: { in: Array.from({ length: 1001 }, (_, i) => i) } }, then: 'x' }];
    expect(decideFromFacts(rules, { n: 1 }, 'post').evidence.rules[0]).toMatchObject({
      matched: false,
      conditions: [],
      matchError: '[REDACTED]',
    });
  });
});

describe('decideFromFacts — no value is kept, whatever the call says', () => {
  it('a fourth argument, even a run rule that keeps every value, is not an option', () => {
    const facts = { express: true, weightKg: 40 };
    const masked = decideFromFacts(SHIPPING, facts, 'post');
    const asked = (decideFromFacts as (...args: unknown[]) => unknown)(SHIPPING, facts, 'post', {
      mask: new RedactionRule().evidenceRule(() => ({})),
    });
    expect(asked).toEqual(masked);
    expect(JSON.stringify(asked)).not.toContain('40');
  });

  it("a function rule's return is never stored: matched is true or false", () => {
    const rules = [
      { when: (f: Facts) => f.token as boolean, then: 'x' },
      { when: (f: Facts) => (f.override || (f.score as number) > 5) as boolean, then: 'y' },
    ];
    const first = decideFromFacts(rules, { token: 'tok-1' }, 'post');
    expect(first).toMatchObject({ branch: 'x', evidence: { rules: [{ matched: true }] } });
    const second = decideFromFacts(rules, { token: '', override: 'ovr-1' }, 'post');
    expect(second.evidence.rules.map((row) => row.matched)).toEqual([false, true]);
    expect(JSON.stringify([first, second])).not.toMatch(/tok-1|ovr-1/);
  });
});

describe('decideFromFacts — how facts are read', () => {
  it('every own data property once, up front: a Proxy is asked ownKeys and one descriptor per key, nothing else', () => {
    const traps: string[] = [];
    const facts = new Proxy({ n: 5, m: 1 } as Facts, {
      ownKeys(target) {
        traps.push('ownKeys');
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, key) {
        traps.push(`descriptor ${String(key)}`);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      get(target, key, receiver) {
        traps.push(`get ${String(key)}`);
        return Reflect.get(target, key, receiver);
      },
      getPrototypeOf(target) {
        traps.push('getPrototypeOf');
        return Reflect.getPrototypeOf(target);
      },
      has(target, key) {
        traps.push(`has ${String(key)}`);
        return Reflect.has(target, key);
      },
    });
    const rules: DecideRule<Facts>[] = [
      { when: { n: { gt: 9 } }, then: 'x' },
      { when: (f) => f.n === 4 || f.n === 6, then: 'y' },
      { when: { n: { eq: 5 } }, then: 'z' },
    ];
    expect(decideFromFacts(rules, facts, 'post').branch).toBe('z');
    expect(traps).toEqual(['ownKeys', 'descriptor n', 'descriptor m']);
  });

  it('class instances, frozen and null-prototype objects and arrays are facts', () => {
    class Order {
      express = true;
    }
    const rule: DecideRule<Facts>[] = [{ when: { express: { eq: true } }, then: 'courier' }];
    for (const facts of [
      new Order(),
      Object.freeze({ express: true }),
      Object.assign(Object.create(null), { express: true }),
    ]) {
      expect(decideFromFacts(rule, facts as Facts, 'post').branch).toBe('courier');
    }
    expect(decideFromFacts([{ when: { 1: { eq: 'b' } } as never, then: 'x' }], ['a', 'b'], 'post').branch).toBe('x');
  });

  it('an inherited name is a missing fact, through a filter and through a function rule', () => {
    const facts = Object.create({ express: true }) as Facts;
    expect(decideFromFacts([{ when: { express: { eq: true } }, then: 'courier' }], facts, 'post').branch).toBe('post');
    expect(decideFromFacts([{ when: (f) => f.toLocaleString !== undefined, then: 'x' }], {}, 'post').branch).toBe(
      'post',
    );
  });

  it('a view a rule kept reads nothing after it returned, and the returned evidence does not change', () => {
    let kept: Facts | undefined;
    const rules: DecideRule<Facts>[] = [
      {
        when: (f) => {
          kept = f;
          return f.a === 1;
        },
        then: 'x',
      },
    ];
    const { evidence } = decideFromFacts(rules, { a: 1, b: 2 }, 'post');
    const before = JSON.stringify(evidence);
    expect(kept?.b).toBeUndefined();
    expect(kept?.a).toBeUndefined();
    expect(JSON.stringify(evidence)).toBe(before);
  });

  it('a prototype-named filter key fails its rule and records no condition', () => {
    const { evidence } = decideFromFacts([{ when: { constructor: { ne: null } } as never, then: 'x' }], {}, 'post');
    expect(evidence.rules[0]).toMatchObject({ matched: false, conditions: [] });
  });
});

describe('decideFromFacts — refused up front: a fact that cannot be read as data', () => {
  const RULES: DecideRule<Facts>[] = [{ when: { heavy: { eq: true } }, then: 'freight' }];

  it('an own accessor property: refused, naming its key; its getter never runs; no rule runs', () => {
    let ran = 0;
    let ruled = 0;
    const rules: DecideRule<Facts>[] = [{ when: () => (ruled += 1) > 0, then: 'x' }, ...RULES];
    const literal = {
      get heavy() {
        ran += 1;
        return true;
      },
    };
    const defined = Object.defineProperty({ express: false } as Facts, 'heavy', {
      get() {
        ran += 1;
        return true;
      },
      enumerable: true,
    });
    for (const facts of [literal, defined]) {
      expect(() => decideFromFacts(rules, facts, 'post')).toThrow(
        new TypeError(
          'decideFromFacts: the fact "heavy" is an accessor property; facts are read as data properties only',
        ),
      );
    }
    expect(ran).toBe(0);
    expect(ruled).toBe(0);
  });

  it('a Proxy reporting an accessor is refused from its descriptor alone: its get trap is never asked', () => {
    let gets = 0;
    const facts = new Proxy({} as Facts, {
      ownKeys: () => ['heavy'],
      getOwnPropertyDescriptor: () => ({ get: () => true, enumerable: true, configurable: true }),
      get: () => {
        gets += 1;
        return true;
      },
    });
    expect(() => decideFromFacts(RULES, facts, 'post')).toThrow(/the fact "heavy" is an accessor property/);
    expect(gets).toBe(0);
  });

  it('a registered stage scope: refused, pointing at decide(scope, …)', async () => {
    expect(() => decideFromFacts(RULES, registerTestScope({ heavy: true }), 'post')).toThrow(
      new TypeError('decideFromFacts: facts is a stage scope; inside a stage, use decide(scope, rules, default)'),
    );
    let refusal: unknown;
    const chart = flowChart<Facts>(
      'Seed',
      (scope) => {
        scope.heavy = true;
      },
      'seed',
    )
      .addFunction(
        'Pick',
        (scope) => {
          try {
            decideFromFacts(RULES, scope, 'post');
          } catch (error) {
            refusal = error;
          }
        },
        'pick',
      )
      .build();
    await new FlowChartExecutor(chart).run();
    expect(refusal).toBeInstanceOf(TypeError);
    expect((refusal as Error).message).toMatch(/facts is a stage scope/);
  });

  it('a Map or a Set: refused', () => {
    for (const facts of [new Map([['heavy', true]]), new Set(['heavy'])]) {
      expect(() => decideFromFacts(RULES, facts as never, 'post')).toThrow(
        new TypeError('decideFromFacts: facts is a Map or a Set; pass a plain record of named values'),
      );
    }
  });

  it('no refusal message holds a value', () => {
    const MARKER = 'MARKER-refusal-value';
    const attempts: unknown[] = [
      Object.defineProperty({} as Facts, 'token', { get: () => MARKER }),
      registerTestScope({ token: MARKER }),
      new Map([['token', MARKER]]),
      new Set([MARKER]),
    ];
    for (const facts of attempts) {
      let message = '';
      try {
        decideFromFacts(RULES, facts as never, 'post');
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/^decideFromFacts: /);
      expect(message).not.toContain(MARKER);
    }
  });
});

describe('decideFromFacts — boundaries', () => {
  it('an empty table chooses the default and records no rows', () => {
    expect(decideFromFacts([], { a: 1 }, 'post').evidence).toEqual({ rules: [], chosen: 'post', default: 'post' });
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
