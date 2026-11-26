/**
 * Tests for decide/decide -- decide() and select() functions.
 *
 * Covers: unit, boundary, scenario (mixed rules), security (Symbol brand, redaction).
 */
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import { decideAttempt } from '../../../../src/lib/attempt/decision';
import { decide, select } from '../../../../src/lib/decide/decide';
import { decideFromFacts } from '../../../../src/lib/decide/fromFacts';
import type { DecideRule } from '../../../../src/lib/decide/types';
import { DECISION_RESULT } from '../../../../src/lib/decide/types';
import { registerTestScope } from '../../../helpers/registerScope';

// -- Mock scope with recorder support ----------------------------------------

function mockScope(state: Record<string, unknown>, redactedKeys: Set<string> = new Set()) {
  const recorders: any[] = [];
  return registerTestScope({
    ...state,
    getValue(key: string) {
      const value = state[key];
      // Dispatch to recorders (same as ScopeFacade)
      for (const r of recorders) {
        r.onRead?.({
          key,
          value: redactedKeys.has(key) ? '[REDACTED]' : value,
          redacted: redactedKeys.has(key),
          stageName: 'test',
          pipelineId: 'p1',
          timestamp: Date.now(),
        });
      }
      return value;
    },
    $getValue(key: string) {
      return this.getValue(key);
    },
    attachScopeRecorder(r: any) {
      recorders.push(r);
    },
    detachScopeRecorder(id: string) {
      const idx = recorders.findIndex((r: any) => r.id === id);
      if (idx >= 0) recorders.splice(idx, 1);
    },
    $attachScopeRecorder(r: any) {
      this.attachScopeRecorder(r);
    },
    $detachScopeRecorder(id: string) {
      this.detachScopeRecorder(id);
    },
    getRedactedKeys() {
      return redactedKeys;
    },
    $toRaw() {
      return this;
    },
  });
}

describe('synchronous function rule returns', () => {
  const syncError = { type: 'function', matched: false, matchError: 'a rule must return synchronously' };

  function rule(returned: () => unknown, branch = 'stop') {
    // JavaScript and unchecked TypeScript can return values beyond the declared boolean contract.
    return { when: returned as () => boolean, then: branch };
  }

  it.each([() => Promise.resolve(true), () => Promise.resolve(false), () => runInNewContext('Promise.resolve(true)')])(
    'rejects a promise in every caller of the shared function row',
    (returned) => {
      const rules = [rule(returned), { when: () => true, then: 'done' }];
      const decision = decide(mockScope({}), rules, 'retry');
      const selection = select(mockScope({}), rules);
      const facts = decideFromFacts(rules, {}, 'retry');
      const attempt = decideAttempt(rules, () => undefined);
      expect([decision.branch, facts.branch, attempt.next]).toEqual(['done', 'done', 'done']);
      expect(selection.branches).toEqual(['done']);
      for (const result of [decision, selection, facts, attempt])
        expect(result.evidence.rules[0]).toMatchObject(syncError);
    },
  );

  it('observes a native rejection and does not put its reason in evidence', async () => {
    const decision = decideFromFacts([rule(() => Promise.reject(new Error('private settlement')))], {}, 'retry');
    expect(decision.branch).toBe('retry');
    expect(decision.evidence.rules[0]).toMatchObject(syncError);
    expect(JSON.stringify(decision)).not.toContain('private settlement');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('keeps the synchronous read and excludes reads attempted after the rule returns', async () => {
    type Facts = { enabled: boolean; later: string };
    const observed: unknown[] = [];
    const predicate = vi.fn(async (facts: Facts) => {
      const enabled = facts.enabled;
      await Promise.resolve();
      observed.push(facts.later);
      return enabled;
    });
    const when = predicate as unknown as (facts: Facts) => boolean;
    const result = decideFromFacts([{ when, then: 'stop' }], { enabled: true, later: 'private' }, 'retry');
    expect(result.branch).toBe('retry');
    expect(result.evidence.rules[0]).toMatchObject({ ...syncError, inputs: [{ key: 'enabled' }] });
    await Promise.resolve();
    expect(predicate).toHaveBeenCalledOnce();
    expect(observed).toEqual([undefined]);
    expect(result.evidence.rules[0]).toMatchObject({ ...syncError, inputs: [{ key: 'enabled' }] });
  });

  it('refuses data and accessor thenables without entering them', () => {
    const then = vi.fn();
    const getThen = vi.fn(() => then);
    const accessor = Object.defineProperty({}, 'then', { get: getThen });
    const inherited = Object.create({ then });
    const result = select(mockScope({}), [
      rule(() => inherited),
      rule(() => accessor),
      rule(() => ({ ok: true }), 'done'),
    ]);
    expect(result.branches).toEqual(['done']);
    expect(result.evidence.rules.slice(0, 2)).toMatchObject([syncError, syncError]);
    expect(then).not.toHaveBeenCalled();
    expect(getThen).not.toHaveBeenCalled();
  });
});

// -- Unit: decide() with function rules --------------------------------------

describe('decide -- function rules', () => {
  it('returns first matching rule branch', () => {
    const scope = mockScope({ score: 750 });
    const result = decide(
      scope,
      [
        { when: (s: any) => s.score > 700, then: 'approved' },
        { when: (s: any) => s.score > 600, then: 'review' },
      ],
      'rejected',
    );
    expect(result.branch).toBe('approved');
  });

  it('skips non-matching rules', () => {
    const scope = mockScope({ score: 650 });
    const result = decide(
      scope,
      [
        { when: (s: any) => s.score > 700, then: 'approved' },
        { when: (s: any) => s.score > 600, then: 'review' },
      ],
      'rejected',
    );
    expect(result.branch).toBe('review');
  });

  it('returns default when no rules match', () => {
    const scope = mockScope({ score: 500 });
    const result = decide(
      scope,
      [
        { when: (s: any) => s.score > 700, then: 'approved' },
        { when: (s: any) => s.score > 600, then: 'review' },
      ],
      'rejected',
    );
    expect(result.branch).toBe('rejected');
  });

  it('captures read evidence automatically', () => {
    const scope = mockScope({ score: 750, dti: 0.38 });
    const result = decide(
      scope,
      [
        {
          when: (s: any) => {
            s.getValue('score');
            s.getValue('dti');
            return true;
          },
          then: 'approved',
        },
      ],
      'rejected',
    );
    const rule = result.evidence.rules[0];
    expect(rule.type).toBe('function');
    if (rule.type === 'function') {
      expect(rule.inputs.length).toBeGreaterThanOrEqual(2);
      expect(rule.inputs.some((i) => i.key === 'score')).toBe(true);
      expect(rule.inputs.some((i) => i.key === 'dti')).toBe(true);
    }
  });
});

// -- Unit: decide() with filter rules ----------------------------------------

describe('decide -- filter rules', () => {
  it('matches filter conditions', () => {
    const scope = mockScope({ score: 750, plan: 'premium' });
    const result = decide(
      scope,
      [{ when: { score: { gt: 700 }, plan: { eq: 'premium' } }, then: 'approved' }],
      'rejected',
    );
    expect(result.branch).toBe('approved');
  });

  it('fails filter when any condition fails', () => {
    const scope = mockScope({ score: 650, plan: 'premium' });
    const result = decide(
      scope,
      [{ when: { score: { gt: 700 }, plan: { eq: 'premium' } }, then: 'approved' }],
      'rejected',
    );
    expect(result.branch).toBe('rejected');
  });

  it('captures filter condition evidence', () => {
    const scope = mockScope({ score: 750 });
    const result = decide(scope, [{ when: { score: { gt: 700 } }, then: 'approved' }], 'rejected');
    const rule = result.evidence.rules[0];
    expect(rule.type).toBe('filter');
    if (rule.type === 'filter') {
      expect(rule.conditions).toHaveLength(1);
      expect(rule.conditions[0]).toMatchObject({
        key: 'score',
        op: 'gt',
        threshold: 700,
        result: true,
      });
    }
  });
});

// -- Unit: mixed rules -------------------------------------------------------

describe('decide -- mixed rules', () => {
  it('evaluates filter first, then function', () => {
    const scope = mockScope({ score: 650, region: 'US' });
    const result = decide(
      scope,
      [
        { when: { score: { gt: 700 } }, then: 'auto-approve' },
        { when: (s: any) => s.getValue('region') === 'US', then: 'manual-review' },
      ],
      'rejected',
    );
    expect(result.branch).toBe('manual-review');
    expect(result.evidence.rules).toHaveLength(2);
    expect(result.evidence.rules[0].type).toBe('filter');
    expect(result.evidence.rules[1].type).toBe('function');
  });
});

// -- Unit: decide() Symbol brand ---------------------------------------------

describe('decide -- Symbol brand', () => {
  it('result carries DECISION_RESULT brand', () => {
    const scope = mockScope({ x: 1 });
    const result = decide(scope, [{ when: () => true, then: 'a' }], 'b');
    expect(Reflect.has(result, DECISION_RESULT)).toBe(true);
    expect(result[DECISION_RESULT]).toBe(true);
  });

  it('default result also carries brand', () => {
    const scope = mockScope({ x: 1 });
    const result = decide(scope, [{ when: () => false, then: 'a' }], 'default');
    expect(Reflect.has(result, DECISION_RESULT)).toBe(true);
    expect(result.branch).toBe('default');
  });
});

// -- Unit: decide() evidence structure ---------------------------------------

describe('decide -- evidence structure', () => {
  it('evidence.chosen matches branch', () => {
    const scope = mockScope({ x: 1 });
    const result = decide(scope, [{ when: () => true, then: 'a' }], 'b');
    expect(result.evidence.chosen).toBe('a');
  });

  it('evidence.default is always set', () => {
    const scope = mockScope({ x: 1 });
    const result = decide(scope, [{ when: () => true, then: 'a' }], 'fallback');
    expect(result.evidence.default).toBe('fallback');
  });

  it('evidence includes all evaluated rules (not just the winner)', () => {
    const scope = mockScope({ x: 1 });
    const result = decide(
      scope,
      [
        { when: () => false, then: 'a' },
        { when: () => false, then: 'b' },
        { when: () => true, then: 'c' },
      ],
      'default',
    );
    expect(result.evidence.rules).toHaveLength(3);
    expect(result.evidence.rules[0].matched).toBe(false);
    expect(result.evidence.rules[1].matched).toBe(false);
    expect(result.evidence.rules[2].matched).toBe(true);
  });

  it('label is preserved in evidence', () => {
    const scope = mockScope({});
    const result = decide(scope, [{ when: () => true, then: 'a', label: 'My Rule' }], 'b');
    expect(result.evidence.rules[0].label).toBe('My Rule');
  });
});

// -- Unit: select() ----------------------------------------------------------

describe('select -- evaluates all rules', () => {
  it('returns all matching branches', () => {
    const scope = mockScope({ glucose: 120, bp: 130, bmi: 32 });
    const result = select(scope, [
      { when: (s: any) => s.getValue('glucose') > 100, then: 'diabetes' },
      { when: (s: any) => s.getValue('bp') > 140, then: 'hypertension' },
      { when: (s: any) => s.getValue('bmi') > 30, then: 'obesity' },
    ]);
    expect(result.branches).toEqual(['diabetes', 'obesity']);
  });

  it('returns empty array when no rules match', () => {
    const scope = mockScope({ glucose: 80, bp: 120, bmi: 22 });
    const result = select(scope, [
      { when: (s: any) => s.getValue('glucose') > 100, then: 'diabetes' },
      { when: (s: any) => s.getValue('bp') > 140, then: 'hypertension' },
    ]);
    expect(result.branches).toEqual([]);
  });

  it('carries DECISION_RESULT brand', () => {
    const scope = mockScope({});
    const result = select(scope, []);
    expect(Reflect.has(result, DECISION_RESULT)).toBe(true);
  });

  it('evidence.selected matches branches', () => {
    const scope = mockScope({ x: 1 });
    const result = select(scope, [
      { when: () => true, then: 'a' },
      { when: () => false, then: 'b' },
      { when: () => true, then: 'c' },
    ]);
    expect(result.evidence.selected).toEqual(['a', 'c']);
    expect(result.evidence.rules).toHaveLength(3);
  });
});

// -- Security: redaction in function path ------------------------------------

describe('decide -- security: redaction', () => {
  it('redacted values show [REDACTED] in function evidence', () => {
    const scope = mockScope({ ssn: '123-45-6789', score: 750 }, new Set(['ssn']));
    const result = decide(
      scope,
      [
        {
          when: (s: any) => {
            s.getValue('ssn');
            s.getValue('score');
            return true;
          },
          then: 'a',
        },
      ],
      'b',
    );
    const rule = result.evidence.rules[0];
    if (rule.type === 'function') {
      const ssnInput = rule.inputs.find((i) => i.key === 'ssn');
      expect(ssnInput?.valueSummary).toBe('[REDACTED]');
      expect(ssnInput?.redacted).toBe(true);
    }
  });
});

// -- Boundary: when() throws -------------------------------------------------

describe('decide -- boundary: when() throws', () => {
  it('treats thrown when() as false match', () => {
    const scope = mockScope({});
    const result = decide(
      scope,
      [
        {
          when: () => {
            throw new Error('boom');
          },
          then: 'a',
        },
        { when: () => true, then: 'b' },
      ],
      'default',
    );
    expect(result.branch).toBe('b');
    expect(result.evidence.rules[0].matched).toBe(false);
  });
});

describe('decide -- boundary: filter path throws (e.g. oversized in array)', () => {
  it('treats thrown filter evaluation as false match', () => {
    const scope = mockScope({ region: 'US' });
    const bigArray = new Array(1001).fill('x');
    const result = decide(
      scope,
      [
        { when: { region: { in: bigArray } } as any, then: 'a' },
        { when: () => true, then: 'b' },
      ],
      'default',
    );
    expect(result.branch).toBe('b');
    expect(result.evidence.rules[0].matched).toBe(false);
  });
});

// -- Boundary: empty rules ---------------------------------------------------

describe('decide -- boundary: empty rules', () => {
  it('returns default with empty rules array', () => {
    const scope = mockScope({});
    const result = decide(scope, [], 'fallback');
    expect(result.branch).toBe('fallback');
    expect(result.evidence.rules).toHaveLength(0);
  });
});
