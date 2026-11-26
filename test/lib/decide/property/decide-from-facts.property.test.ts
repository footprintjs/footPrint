/**
 * `decideFromFacts` — PROPERTY tests: one law, two doors.
 *
 *   1. Under REAL redaction policies that select every key (by name, by pattern, by declared fields, and a mix), for ANY
 *      rule table (filter rules, function rules that return booleans or values or throw), facts and default, the
 *      evidence deep-equals — key order included — what `decide()` records in a decider stage of that run over state
 *      holding the same facts, and the branch is the same. The one field served differently is `matchError`: the run
 *      quotes a thrown rule's text when the rule read nothing selected first, this door never does; so the run's text
 *      is replaced by the placeholder, on exactly the rows where the run has one.
 *   2. The same equality with `decide()` over a registered scope port whose `getRedactedKeys()` returns every key (no
 *      `decisionEvidenceRule`, so it takes `evaluateFilter`'s own default path).
 *   3. The record is a projection of that evidence: `by: 'rule'` exactly when the last row matched, its rule is that
 *      row, its names are names the evidence holds, and its strategy is the branch.
 *
 * Test type: Property (fast-check). The attempt rule table's own equal-evidence law (decideAttempt, decide() and
 * decideFromFacts over the same inputs) is in test/lib/attempt/property/attempt-series.property.test.ts.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { DecisionEvidence } from '../../../../src/index.js';
import { decideFromFacts, decisionRecord } from '../../../../src/index.js';
import { SCOPE_PLACEHOLDER } from '../../../../src/lib/memory/redaction.js';
import {
  decideInRun,
  decideOverEveryKeyPort,
  defaultArb,
  EVERY_KEY_POLICIES,
  factsArb,
  rulesOf,
  specsArb,
  withMatchErrors,
} from '../helpers/ruleTables.js';

/** `actual` equals `expected` with every quoted thrown text served as the placeholder, and the same rows threw. */
function expectEqualEvidence(actual: DecisionEvidence, expected: DecisionEvidence): void {
  const served = withMatchErrors(expected, SCOPE_PLACEHOLDER);
  expect(actual).toEqual(served);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(served));
  expect(actual.rules.map((row) => row.matchError !== undefined)).toEqual(
    expected.rules.map((row) => row.matchError !== undefined),
  );
}

describe('decideFromFacts — equal evidence with decide()', () => {
  it.each(
    EVERY_KEY_POLICIES.map(
      (policy) => [JSON.stringify(policy, (_k, v) => (v instanceof RegExp ? String(v) : v)), policy] as const,
    ),
  )('in a real run under %s: decide()’s evidence, field for field, key for key', async (_name, policy) => {
    await fc.assert(
      fc.asyncProperty(specsArb, factsArb, defaultArb, async (specs, facts, defaultBranch) => {
        const fromRun = await decideInRun(rulesOf(specs), facts, defaultBranch, policy);
        const fromFacts = decideFromFacts(rulesOf(specs), facts, defaultBranch);
        expect(fromFacts.branch).toBe(fromRun.branch);
        expectEqualEvidence(fromFacts.evidence, fromRun.evidence);
      }),
      { numRuns: 100 },
    );
  });

  it('over a registered port whose redacted keys are every key', () => {
    fc.assert(
      fc.property(specsArb, factsArb, defaultArb, (specs, facts, defaultBranch) => {
        const fromPort = decideOverEveryKeyPort(rulesOf(specs), facts, defaultBranch);
        const fromFacts = decideFromFacts(rulesOf(specs), facts, defaultBranch);
        expect(fromFacts.branch).toBe(fromPort.branch);
        expectEqualEvidence(fromFacts.evidence, fromPort.evidence);
      }),
      { numRuns: 300 },
    );
  });
});

describe('decisionRecord — a projection of the evidence', () => {
  it('rule iff the last row matched; names come from the rows; the strategy is the branch', () => {
    fc.assert(
      fc.property(specsArb, factsArb, defaultArb, (specs, facts, defaultBranch) => {
        const { branch, evidence } = decideFromFacts(rulesOf(specs), facts, defaultBranch);
        const record = decisionRecord(evidence);
        const last = evidence.rules.at(-1);
        const winner = last?.matched ? last : undefined;
        expect(record.strategy).toBe(branch);
        expect(record.by).toBe(winner ? 'rule' : 'default');
        if (winner) {
          expect(record.rule).toBe(winner.ruleIndex);
          expect(record.label).toBe(winner.label);
        } else {
          expect(record).not.toHaveProperty('rule');
          expect(record.label).toBe(evidence.defaultLabel);
        }
        const rows = winner ? [winner] : evidence.rules;
        const names = rows.flatMap((row) =>
          row.type === 'filter' ? row.conditions.map((c) => c.key) : row.inputs.map((i) => i.key),
        );
        expect(record.reads).toEqual([...new Set(names)]);
        expect(record).not.toHaveProperty('voucher');
        for (const row of evidence.rules) expect(typeof row.matched).toBe('boolean');
      }),
      { numRuns: 300 },
    );
  });
});
