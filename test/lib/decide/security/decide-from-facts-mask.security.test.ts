/**
 * `decideFromFacts` — SECURITY: names only. A fact whose VALUE is a marker string never appears anywhere in the result
 * (the branch, the evidence, the record), whatever rule reads it, whatever it returns and however it throws, and never
 * in a dev-mode warning. Its twin, so the first cannot pass by hiding everything: the same rules on the same core with
 * every value kept DO show the marker, and the rule still decides on the real value.
 *
 * And the same law for the scope door: a function rule that RETURNS a selected value (`(s) => s.token`) puts it on no
 * surface of `decide()` or `select()` in a run whose redaction policy selects it.
 *
 * Test type: Security.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DecideRule, RedactionPolicy } from '../../../../src/index.js';
import {
  decide,
  decideFromFacts,
  decisionRecord,
  disableDevMode,
  enableDevMode,
  flowChart,
  select,
} from '../../../../src/index.js';
import { firstMatch, KEEP_EVERY_VALUE, ruleOver } from '../../../../src/lib/filter/firstMatch.js';
import { evidenceSurfaces, surfacesHolding } from '../helpers/evidenceSurfaces.js';

const MARKER = 'MARKER-7f3c-secret';
type Facts = Record<string, unknown>;

/** Every way a rule can carry a fact's value into evidence. */
const CASES: ReadonlyArray<{ name: string; rules: DecideRule<Facts>[]; facts: Facts }> = [
  {
    name: 'a filter equality on the value',
    rules: [{ when: { token: { eq: MARKER } }, then: 'x' }],
    facts: { token: MARKER },
  },
  {
    name: 'a filter that does not match it',
    rules: [{ when: { token: { ne: MARKER } }, then: 'x' }],
    facts: { token: MARKER },
  },
  {
    name: 'an in list holding it',
    rules: [{ when: { token: { in: ['a', MARKER] } }, then: 'x' }],
    facts: { token: MARKER },
  },
  {
    name: 'an ordered compare with no order',
    rules: [{ when: { token: { gt: 3 } }, then: 'x' }],
    facts: { token: MARKER },
  },
  {
    name: 'an unknown operator',
    rules: [{ when: { token: { gle: MARKER } } as never, then: 'x' }],
    facts: { token: MARKER },
  },
  {
    name: 'a function rule reading it',
    rules: [{ when: (f) => f.token === MARKER, then: 'x' }],
    facts: { token: MARKER },
  },
  {
    name: 'an object fact whose key is the marker',
    rules: [{ when: (f) => typeof f.profile === 'object', then: 'x' }],
    facts: { profile: { [MARKER]: 1 } },
  },
  {
    name: 'a function rule throwing an Error with the value in its message',
    rules: [
      {
        when: (f) => {
          throw new Error(`bad token ${String(f.token)}`);
        },
        then: 'x',
      },
    ],
    facts: { token: MARKER },
  },
  {
    name: 'a function rule throwing the value itself',
    rules: [
      {
        when: (f) => {
          throw f.token;
        },
        then: 'x',
      },
    ],
    facts: { token: MARKER },
  },
  {
    name: 'a function rule throwing an object whose text holds the value',
    rules: [
      {
        when: (f) => {
          const thrown = { toString: () => `object ${String(f.token)}` };
          throw thrown;
        },
        then: 'x',
      },
    ],
    facts: { token: MARKER },
  },
  {
    name: 'a function rule returning the value',
    rules: [{ when: (f) => f.token as boolean, then: 'x' }],
    facts: { token: MARKER },
  },
  {
    name: 'a function rule returning the value through ||',
    rules: [{ when: (f) => (f.override || (f.score as number) > 5) as boolean, then: 'x' }],
    facts: { override: MARKER, score: 1 },
  },
  {
    name: 'a filter that throws after reading it',
    rules: [{ when: { token: { eq: MARKER }, n: { in: Array.from({ length: 1001 }, (_, i) => i) } }, then: 'x' }],
    facts: { token: MARKER, n: 1 },
  },
];

const FALLBACK = { branch: 'post', label: 'No rule fired' };

/** Everything a caller gets back, as text. */
function served(rules: DecideRule<Facts>[], facts: Facts): string {
  const result = decideFromFacts(rules, facts, FALLBACK);
  return JSON.stringify({ result, record: decisionRecord(result.evidence) });
}

/** The same rules on the same first-match core, every value kept: what the evidence would hold without the mask. */
function unmasked(rules: DecideRule<Facts>[], facts: Facts): string {
  const { branch, evidence } = firstMatch(
    rules,
    ruleOver<Facts>((key) => facts[key], KEEP_EVERY_VALUE),
    FALLBACK,
  );
  return JSON.stringify({ branch, evidence, record: decisionRecord(evidence) });
}

afterEach(() => {
  disableDevMode();
  vi.restoreAllMocks();
});

describe('decideFromFacts — the default mask holds no value', () => {
  for (const { name, rules, facts } of CASES) {
    it(`${name}: the marker is nowhere in the result`, () => {
      expect(served(rules, facts)).not.toContain(MARKER);
    });
  }

  it('the twin: on the same core with every value kept, the same rules do show the marker', () => {
    const showing = CASES.filter(({ rules, facts }) => unmasked(rules, facts).includes(MARKER)).map((c) => c.name);
    // Every case puts the value on a row when nothing masks it, but one: a filter that throws keeps no conditions
    // at all, masked or not, and its error text (the list's size limit) names no value.
    expect(showing).toEqual(
      CASES.map((c) => c.name).filter((name) => name !== 'a filter that throws after reading it'),
    );
  });

  it('the rule still decides on the real value', () => {
    expect(decideFromFacts([{ when: { token: { eq: MARKER } }, then: 'x' }], { token: MARKER }, 'post').branch).toBe(
      'x',
    );
    expect(decideFromFacts([{ when: (f) => f.token === MARKER, then: 'x' }], { token: MARKER }, 'post').branch).toBe(
      'x',
    );
  });

  it('in dev mode, no warning names the value', () => {
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const { rules, facts } of CASES) served(rules, facts);
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(MARKER);
  });
});

/** A rule that returns a selected value, at the scope door: `decide()` and `select()` in a run under a policy. The
 * marker is written only under the name the policy selects. */
const RETURNING: ReadonlyArray<{
  name: string;
  policy: RedactionPolicy;
  seed: (s: any) => void;
  when: (s: any) => boolean;
}> = [
  {
    name: '(s) => s.token',
    policy: { keys: ['token'] },
    seed: (s) => {
      s.token = MARKER;
    },
    when: (s) => s.token,
  },
  {
    name: '(s) => s.override || s.score > 5',
    policy: { keys: ['override'] },
    seed: (s) => {
      s.override = MARKER;
      s.score = 1;
    },
    when: (s) => s.override || s.score > 5,
  },
  {
    name: '(s) => s.token, selected by a pattern',
    policy: { patterns: [/^tok/] },
    seed: (s) => {
      s.token = MARKER;
    },
    when: (s) => s.token,
  },
];

function chartOf(door: 'decide' | 'select', seed: (s: any) => void, when: (s: any) => boolean) {
  const start = flowChart<any>('Seed', seed, 'seed');
  const branches = (cursor: any) =>
    cursor.addFunctionBranch('yes', 'Yes', () => undefined).addFunctionBranch('no', 'No', () => undefined);
  const rules = [{ when, then: 'yes', label: 'returns a value' }];
  if (door === 'decide') {
    return branches(start.addDeciderFunction('Route', (s: any) => decide(s, rules, 'no'), 'route'))
      .setDefault('no')
      .end()
      .build();
  }
  return branches(start.addSelectorFunction('Pick', (s: any) => select(s, rules), 'pick'))
    .end()
    .build();
}

describe.each(['decide', 'select'] as const)('%s() in a run: a rule that returns a selected value', (door) => {
  it.each(RETURNING.map((route) => [route.name, route] as const))(
    '%s: on no surface, and matched is true',
    async (_name, route) => {
      const surfaces = await evidenceSurfaces(chartOf(door, route.seed, route.when), route.policy);
      expect(surfaces.evidence.length).toBeGreaterThan(0);
      for (const evidence of surfaces.evidence) expect(evidence.rules[0].matched).toBe(true);
      expect(surfacesHolding(surfaces, MARKER)).toEqual([]);
    },
  );
});
