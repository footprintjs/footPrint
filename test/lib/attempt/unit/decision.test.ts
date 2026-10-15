/**
 * `attempt/decision.ts` — the ONE retry rule table (`retryRules`) and the runner's evidence builder
 * (`decideAttempt`). A retry-or-stop decision is a `DecisionEvidence`, the shape `decide()` produces, so the
 * Lens and an agent read every retry the way they read a decider (design §3.1, §3.8, law 9).
 *
 * Test types: Unit (the table; the decision per rule — `next`, `reason`, each evidence row's key / op /
 * threshold / actualSummary / result; key order) · Boundary (lazy inputs: a rule's inputs are read only when the
 * rule is reached, so the user's `retryOn` and `backoffMs` run exactly when they ran before 10.1; a throwing
 * function rule).
 */
import { describe, expect, it } from 'vitest';

import { decideAttempt, RETRY_DEFAULT, retryRules } from '../../../../src/lib/attempt/decision.js';
import type { AttemptInputs } from '../../../../src/lib/attempt/types.js';
import type { DecideRule } from '../../../../src/lib/decide/types.js';

const BASE: AttemptInputs = {
  outcome: 'failed',
  category: 'unknown',
  aborted: false,
  attempt: 1,
  of: 3,
  timeLeftMs: Infinity,
  delayMs: 0,
  timeLeftAfterWaitMs: Infinity,
  retryOn: true,
  keyPresent: false,
};

/** A reader over fixed inputs that counts what each key was asked for. */
function reader(inputs: Partial<AttemptInputs>) {
  const all = { ...BASE, ...inputs } as Record<string, unknown>;
  const reads: string[] = [];
  const read = (key: string) => {
    reads.push(key);
    return all[key];
  };
  return { reads, read };
}

describe('retryRules — the table', () => {
  it('six rules in order, then the default; each label IS the stop reason it names', () => {
    const rules = retryRules({ attempts: 3 });
    expect(rules.map((r) => [r.then, r.label])).toEqual([
      ['done', 'succeeded'],
      ['stop', 'paused'],
      ['stop', 'aborted'],
      ['stop', 'exhausted'],
      ['stop', 'declined'],
      ['stop', 'no-time-left'],
    ]);
    expect(rules.map((r) => typeof r.when)).toEqual(['object', 'object', 'object', 'object', 'function', 'object']);
    // Rule 3 reads the run's signal, not the attempt's outcome: an attempt that failed on its own while the run
    // aborted keeps `failed`, and the abort is why the series stopped.
    expect(rules[2].when).toEqual({ aborted: { eq: true } });
    expect(rules[3].when).toEqual({ attempt: { gte: 3 } });
    expect(rules[5].when).toEqual({ timeLeftAfterWaitMs: { lte: 0 } });
    expect(RETRY_DEFAULT).toEqual({ branch: 'retry', label: 'retryable' });
  });

  it('the ceiling is the whole number of attempts the engine has always allowed', () => {
    expect(retryRules({ attempts: 3.9 })[3].when).toEqual({ attempt: { gte: 3 } });
  });

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['0', 0],
    ['a negative', -2],
  ])(
    'a ceiling of %s is one attempt — rule 4 can never be out of reach (the runner’s and the gate’s reading)',
    (_l, n) => {
      expect(retryRules({ attempts: n })[3].when).toEqual({ attempt: { gte: 1 } });
    },
  );
});

describe('decideAttempt — one decision per rule', () => {
  const rules = retryRules({ attempts: 3 });

  it('ok → done, succeeded: one row, nothing else read', () => {
    const { read, reads } = reader({ outcome: 'ok' });
    const decision = decideAttempt(rules, read);
    expect(decision.next).toBe('done');
    expect(decision.reason).toBe('succeeded');
    expect(decision.evidence).toEqual({
      rules: [
        {
          type: 'filter',
          ruleIndex: 0,
          branch: 'done',
          matched: true,
          label: 'succeeded',
          conditions: [
            { key: 'outcome', op: 'eq', threshold: 'ok', actualSummary: '"ok"', result: true, redacted: false },
          ],
        },
      ],
      chosen: 'done',
      default: 'retry',
      defaultLabel: 'retryable',
    });
    expect(reads).toEqual(['outcome']);
  });

  it('paused → stop, paused; the run aborted → stop, aborted — whatever the attempt’s own outcome', () => {
    const paused = decideAttempt(rules, reader({ outcome: 'paused' }).read);
    expect([paused.next, paused.reason, paused.evidence.rules.length]).toEqual(['stop', 'paused', 2]);
    for (const outcome of ['failed', 'aborted'] as const) {
      const { read, reads } = reader({ outcome, aborted: true });
      const aborted = decideAttempt(rules, read);
      expect([aborted.next, aborted.reason, aborted.evidence.rules.length]).toEqual(['stop', 'aborted', 3]);
      expect(aborted.evidence.rules[2]).toEqual({
        type: 'filter',
        ruleIndex: 2,
        branch: 'stop',
        matched: true,
        label: 'aborted',
        conditions: [
          { key: 'aborted', op: 'eq', threshold: true, actualSummary: 'true', result: true, redacted: false },
        ],
      });
      // The abort decides first: retryOn is never asked.
      expect(reads).not.toContain('retryOn');
    }
  });

  it('the last attempt → stop, exhausted — before retryOn is ever asked', () => {
    const { read, reads } = reader({ attempt: 3 });
    const decision = decideAttempt(rules, read);
    expect([decision.next, decision.reason]).toEqual(['stop', 'exhausted']);
    expect(decision.evidence.rules[3]).toEqual({
      type: 'filter',
      ruleIndex: 3,
      branch: 'stop',
      matched: true,
      label: 'exhausted',
      conditions: [{ key: 'attempt', op: 'gte', threshold: 3, actualSummary: '3', result: true, redacted: false }],
    });
    expect(reads).not.toContain('retryOn');
    expect(reads).not.toContain('timeLeftAfterWaitMs');
  });

  it('retryOn false → stop, declined: a FUNCTION row with the input it saw', () => {
    const { read, reads } = reader({ retryOn: false });
    const decision = decideAttempt(rules, read);
    expect([decision.next, decision.reason]).toEqual(['stop', 'declined']);
    expect(decision.evidence.rules[4]).toEqual({
      type: 'function',
      ruleIndex: 4,
      branch: 'stop',
      matched: true,
      label: 'declined',
      inputs: [{ key: 'retryOn', valueSummary: 'false', redacted: false }],
    });
    expect(reads).not.toContain('timeLeftAfterWaitMs');
  });

  it('no time for the wait → stop, no-time-left', () => {
    const decision = decideAttempt(rules, reader({ timeLeftAfterWaitMs: -200 }).read);
    expect([decision.next, decision.reason]).toEqual(['stop', 'no-time-left']);
    expect(decision.evidence.rules[5].matched).toBe(true);
  });

  it('nothing stops it → the default: retry, retryable, with all six rows unmatched', () => {
    const decision = decideAttempt(rules, reader({}).read);
    expect([decision.next, decision.reason]).toEqual(['retry', 'retryable']);
    expect(decision.evidence.chosen).toBe('retry');
    expect(decision.evidence.rules.map((r) => r.matched)).toEqual([false, false, false, false, false, false]);
    expect(decision.evidence.rules[5]).toMatchObject({
      conditions: [{ key: 'timeLeftAfterWaitMs', op: 'lte', threshold: 0, actualSummary: 'Infinity', result: false }],
    });
  });

  it('keeps decide()’s key order, so a pinned JSON reads the same as a decider’s', () => {
    const decision = decideAttempt(rules, reader({ retryOn: false }).read);
    expect(Object.keys(decision.evidence)).toEqual(['rules', 'chosen', 'default', 'defaultLabel']);
    expect(Object.keys(decision.evidence.rules[0])).toEqual([
      'type',
      'ruleIndex',
      'branch',
      'matched',
      'label',
      'conditions',
    ]);
    expect(Object.keys(decision.evidence.rules[4])).toEqual([
      'type',
      'ruleIndex',
      'branch',
      'matched',
      'label',
      'inputs',
    ]);
  });
});

describe('decideAttempt — lazy inputs and a throwing rule', () => {
  it('reads each input only when a rule reaches it, in rule order', () => {
    const { read, reads } = reader({});
    decideAttempt(retryRules({ attempts: 3 }), read);
    expect(reads).toEqual(['outcome', 'outcome', 'aborted', 'attempt', 'retryOn', 'timeLeftAfterWaitMs']);
  });

  it('a function rule that throws does not match, and says why — as decide() does', () => {
    const rules: DecideRule<AttemptInputs>[] = [
      {
        when: () => {
          throw new Error('rule broke');
        },
        then: 'stop',
        label: 'broken',
      },
    ];
    const decision = decideAttempt(rules, reader({}).read);
    expect(decision.evidence.rules[0]).toEqual({
      type: 'function',
      ruleIndex: 0,
      branch: 'stop',
      matched: false,
      label: 'broken',
      inputs: [],
      matchError: 'rule broke',
    });
    expect([decision.next, decision.reason]).toEqual(['retry', 'retryable']);
  });
});
