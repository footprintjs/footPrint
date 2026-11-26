/**
 * `decideFromFacts` under its default mask — SECURITY: names only. A fact whose VALUE is a marker string never
 * appears anywhere in the result (the branch, the evidence, the record), whatever rule reads it and however it
 * throws, and never in a dev-mode warning. Its twin, so the first cannot pass by hiding everything: the same calls
 * with a run's rule (no policy) DO show the marker, and the rule still decides on the real value.
 *
 * Test type: Security.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DecideRule } from '../../../../src/index.js';
import { decideFromFacts, decisionRecord, disableDevMode, enableDevMode } from '../../../../src/index.js';
import { RedactionRule } from '../../../../src/lib/memory/redaction.js';

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
    name: 'a filter that throws after reading it',
    rules: [{ when: { token: { eq: MARKER }, n: { in: Array.from({ length: 1001 }, (_, i) => i) } }, then: 'x' }],
    facts: { token: MARKER, n: 1 },
  },
];

/** Everything a caller gets back, as text. */
function served(rules: DecideRule<Facts>[], facts: Facts, options?: Parameters<typeof decideFromFacts>[3]): string {
  const result = decideFromFacts(rules, facts, { branch: 'post', label: 'No rule fired' }, options);
  return JSON.stringify({ result, record: decisionRecord(result.evidence) });
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

  it('the twin: with a run that keeps values, the same calls do show the marker', () => {
    const keep = { mask: new RedactionRule().evidenceRule(() => ({})) };
    const showing = CASES.filter(({ rules, facts }) => served(rules, facts, keep).includes(MARKER)).map((c) => c.name);
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
