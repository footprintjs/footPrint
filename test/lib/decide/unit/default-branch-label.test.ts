/**
 * Tests for decide()'s labelled default branch (`DefaultBranch` object form).
 *
 * The default branch is chosen by NO rule, so `rules[].label` can never name
 * it — it is the one branch evidence could not describe. The object form of
 * `defaultBranch` declares that meaning beside the rules, and it rides out on
 * `DecisionEvidence.defaultLabel`.
 *
 * Covers: unit (both forms), functional (both exit paths), property (the bare
 * string is byte-identical to the pre-9.16 shape across many rule sets),
 * boundary (object without a label).
 */
import { describe, expect, it } from 'vitest';

import { decide } from '../../../../src/lib/decide/decide';
import type { DecideRule, DecisionEvidence } from '../../../../src/lib/decide/types';

// -- Mock scope (same shape as decide.test.ts) -------------------------------

function mockScope(state: Record<string, unknown>) {
  const recorders: any[] = [];
  return {
    ...state,
    getValue(key: string) {
      const value = state[key];
      for (const r of recorders) {
        r.onRead?.({
          key,
          value,
          redacted: false,
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
      return new Set<string>();
    },
    $toRaw() {
      return this;
    },
  };
}

/** Rule sets that exercise every evidence shape decide() can emit. */
function ruleSets(): { name: string; rules: DecideRule<any>[] }[] {
  return [
    { name: 'no rules', rules: [] },
    { name: 'one function rule that matches', rules: [{ when: (s: any) => s.getValue('score') > 700, then: 'a' }] },
    { name: 'one function rule that misses', rules: [{ when: (s: any) => s.getValue('score') > 900, then: 'a' }] },
    { name: 'labelled filter rule that matches', rules: [{ when: { score: { gt: 700 } }, then: 'a', label: 'High' }] },
    { name: 'labelled filter rule that misses', rules: [{ when: { score: { gt: 900 } }, then: 'a', label: 'High' }] },
    {
      name: 'mixed rules, second wins',
      rules: [
        { when: { score: { gt: 900 } }, then: 'a', label: 'Very high' },
        { when: (s: any) => s.getValue('score') > 700, then: 'b', label: 'High' },
      ],
    },
    {
      name: 'every rule misses',
      rules: [
        { when: { score: { gt: 900 } }, then: 'a', label: 'Very high' },
        { when: (s: any) => s.getValue('score') > 900, then: 'b', label: 'Also very high' },
      ],
    },
    {
      name: 'a rule throws',
      rules: [
        {
          when: () => {
            throw new Error('boom');
          },
          then: 'a',
        },
      ],
    },
  ];
}

// -- Unit: the bare string is unchanged --------------------------------------

describe('decide -- bare-string default (unchanged behaviour)', () => {
  it('omits defaultLabel entirely — the key is absent, not undefined', () => {
    const scope = mockScope({ score: 750 });
    const result = decide(scope, [{ when: (s: any) => s.getValue('score') > 700, then: 'a' }], 'rejected');

    expect(Object.prototype.hasOwnProperty.call(result.evidence, 'defaultLabel')).toBe(false);
    expect(Object.keys(result.evidence)).toEqual(['rules', 'chosen', 'default']);
  });

  it('produces byte-identical evidence to the pre-9.16 shape (pinned)', () => {
    const scope = mockScope({ score: 750 });
    const result = decide(scope, [{ when: { score: { gt: 700 } }, then: 'a', label: 'High' }], 'rejected');

    // This literal IS the 9.15.x output. Widening `defaultBranch` must not
    // move a single byte of it for a caller that passes a string.
    expect(JSON.parse(JSON.stringify(result.evidence))).toEqual({
      rules: [
        {
          type: 'filter',
          ruleIndex: 0,
          branch: 'a',
          matched: true,
          label: 'High',
          conditions: [{ key: 'score', op: 'gt', threshold: 700, actualSummary: '750', result: true, redacted: false }],
        },
      ],
      chosen: 'a',
      default: 'rejected',
    });
  });

  it('still returns the default branch as the result branch when nothing matches', () => {
    const scope = mockScope({ score: 100 });
    const result = decide(scope, [{ when: { score: { gt: 700 } }, then: 'a' }], 'rejected');

    expect(result.branch).toBe('rejected');
    expect(result.evidence.chosen).toBe('rejected');
    expect(result.evidence.default).toBe('rejected');
  });
});

// -- Property: string form ≡ object form without a label ---------------------

describe('decide -- property: the two unlabelled forms are byte-identical', () => {
  for (const { name, rules } of ruleSets()) {
    it(`${name}: 'rejected' and { branch: 'rejected' } serialize identically`, () => {
      const asString = decide(mockScope({ score: 750 }), rules, 'rejected');
      const asObject = decide(mockScope({ score: 750 }), rules, { branch: 'rejected' });

      expect(JSON.stringify(asObject.evidence)).toBe(JSON.stringify(asString.evidence));
      expect(asObject.branch).toBe(asString.branch);
      expect(Object.prototype.hasOwnProperty.call(asObject.evidence, 'defaultLabel')).toBe(false);
    });
  }
});

// -- Functional: the label lands on BOTH exit paths --------------------------

describe('decide -- labelled default', () => {
  const labelled = { branch: 'protected', label: 'No rule fired — the asset stays protected' } as const;

  it('records defaultLabel when the default FIRES (no rule matched)', () => {
    const scope = mockScope({ score: 100 });
    const result = decide(scope, [{ when: { score: { gt: 700 } }, then: 'open', label: 'High score' }], labelled);

    expect(result.branch).toBe('protected');
    expect(result.evidence.chosen).toBe('protected');
    expect(result.evidence.defaultLabel).toBe('No rule fired — the asset stays protected');
  });

  it('records defaultLabel when a RULE won — the meaning must not depend on the data', () => {
    const scope = mockScope({ score: 750 });
    const result = decide(scope, [{ when: { score: { gt: 700 } }, then: 'open', label: 'High score' }], labelled);

    expect(result.branch).toBe('open');
    expect(result.evidence.chosen).toBe('open');
    expect(result.evidence.default).toBe('protected');
    expect(result.evidence.defaultLabel).toBe('No rule fired — the asset stays protected');
  });

  it('a harvester sees the same set of branch meanings on both paths', () => {
    const rules: DecideRule<any>[] = [{ when: { score: { gt: 700 } }, then: 'open', label: 'High score' }];
    const meanings = (evidence: DecisionEvidence) => {
      const out: Record<string, string> = {};
      for (const r of evidence.rules) if (r.label) out[r.branch] = r.label;
      if (evidence.defaultLabel) out[evidence.default] = evidence.defaultLabel;
      return out;
    };

    const ruleWon = decide(mockScope({ score: 750 }), rules, labelled);
    const defaultFired = decide(mockScope({ score: 100 }), rules, labelled);

    expect(meanings(ruleWon.evidence)).toEqual(meanings(defaultFired.evidence));
    expect(meanings(ruleWon.evidence)).toEqual({
      open: 'High score',
      protected: 'No rule fired — the asset stays protected',
    });
  });

  it('keeps the default branch id in `default` and in the returned branch', () => {
    const scope = mockScope({ score: 100 });
    const result = decide(scope, [], { branch: 'protected', label: 'Nothing to evaluate' });

    expect(result.branch).toBe('protected');
    expect(result.evidence.default).toBe('protected');
  });
});

// -- Boundary: object without a label ----------------------------------------

describe('decide -- object default without a label', () => {
  it('behaves exactly like the bare string', () => {
    const rules: DecideRule<any>[] = [{ when: { score: { gt: 700 } }, then: 'open' }];
    const bare = decide(mockScope({ score: 100 }), rules, 'protected');
    const object = decide(mockScope({ score: 100 }), rules, { branch: 'protected' });

    expect(JSON.stringify(object.evidence)).toBe(JSON.stringify(bare.evidence));
    expect(Object.prototype.hasOwnProperty.call(object.evidence, 'defaultLabel')).toBe(false);
  });

  it('an explicitly undefined label is still absent from evidence', () => {
    const result = decide(mockScope({ score: 100 }), [], { branch: 'protected', label: undefined });

    expect(Object.prototype.hasOwnProperty.call(result.evidence, 'defaultLabel')).toBe(false);
  });

  it('an empty-string label is treated as no label by the narrative, but is preserved verbatim', () => {
    const result = decide(mockScope({ score: 100 }), [], { branch: 'protected', label: '' });

    // Preserved as given — decide() never invents or edits a caller's words.
    expect(result.evidence.defaultLabel).toBe('');
  });
});
