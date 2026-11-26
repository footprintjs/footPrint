/**
 * `decideFromFacts` — PROPERTY tests: one law, two doors.
 *
 *   1. With a run's rule as the mask (here a run with no policy), for ANY rule table, facts and default, the evidence
 *      deep-equals — key order included — what `decide()` records in a decider stage over state holding the same
 *      facts, and the branch is the same.
 *   2. Mask-all is tested as equal evidence with `decide()` over a registered scope port whose `getRedactedKeys()`
 *      returns every key. The one field it serves differently is `matchError`: the port quotes a thrown rule's text,
 *      mask-all serves the placeholder — on exactly the rows where the port has one.
 *   3. The record is a projection of that evidence: `by: 'rule'` exactly when the last row matched, its rule is that
 *      row, its names are names the evidence holds, and its strategy is the branch.
 *
 * Test type: Property (fast-check). The attempt rule table's own equal-evidence law (decideAttempt, decide() and
 * decideFromFacts over the same inputs) is in test/lib/attempt/property/attempt-series.property.test.ts.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { decideFromFacts, decisionRecord } from '../../../../src/index.js';
import { RedactionRule, SCOPE_PLACEHOLDER } from '../../../../src/lib/memory/redaction.js';
import {
  decideInRun,
  decideOverEveryKeyPort,
  defaultArb,
  factsArb,
  rulesOf,
  specsArb,
  withMatchErrors,
} from '../helpers/ruleTables.js';

/** The answers a run with no redaction policy gives `decide()`. */
const runRule = () => new RedactionRule().evidenceRule(() => ({}));

describe('decideFromFacts — equal evidence with decide()', () => {
  it("with a run's rule: decide()'s evidence in a real run, field for field, key for key", async () => {
    await fc.assert(
      fc.asyncProperty(specsArb, factsArb, defaultArb, async (specs, facts, defaultBranch) => {
        const fromDecide = await decideInRun(rulesOf(specs), facts, defaultBranch);
        const fromFacts = decideFromFacts(rulesOf(specs), facts, defaultBranch, { mask: runRule() });
        expect(fromFacts.branch).toBe(fromDecide.branch);
        expect(fromFacts.evidence).toEqual(fromDecide.evidence);
        expect(JSON.stringify(fromFacts.evidence)).toBe(JSON.stringify(fromDecide.evidence));
      }),
      { numRuns: 150 },
    );
  });

  it('mask-all (the default): decide() over a port whose redacted keys are every key', () => {
    fc.assert(
      fc.property(specsArb, factsArb, defaultArb, (specs, facts, defaultBranch) => {
        const fromPort = decideOverEveryKeyPort(rulesOf(specs), facts, defaultBranch);
        const fromFacts = decideFromFacts(rulesOf(specs), facts, defaultBranch);
        const expected = withMatchErrors(fromPort.evidence, SCOPE_PLACEHOLDER);
        expect(fromFacts.branch).toBe(fromPort.branch);
        expect(fromFacts.evidence).toEqual(expected);
        expect(JSON.stringify(fromFacts.evidence)).toBe(JSON.stringify(expected));
        // The same rows threw on both doors; only the text differs.
        expect(fromFacts.evidence.rules.map((row) => row.matchError !== undefined)).toEqual(
          fromPort.evidence.rules.map((row) => row.matchError !== undefined),
        );
        // `{ mask: 'all' }` is the default, spelled out.
        expect(decideFromFacts(rulesOf(specs), facts, defaultBranch, { mask: 'all' })).toEqual(fromFacts);
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
      }),
      { numRuns: 300 },
    );
  });
});
