/** Inert synthetic data controls; these do not claim real scenario execution. */
import { createHash } from 'node:crypto';

import { expect, it } from 'vitest';

import { readTiersCandidate } from './analysis.js';

const FAILURE = "TypeError: Cannot read properties of undefined (reading 'push')";
const print = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
function example() {
  const before = {
    snapshot: {
      sharedState: { x: [0], y: [1] },
      executionTree: {
        id: 'before-first-write',
        next: {
          id: 'after-first-write',
          runtimeStageId: 'after-first-write#1',
          stageReads: { x: [] },
          stageWrites: { x: [0] },
          errors: {},
        },
      },
      commitLog: [
        {},
        {
          stageId: 'after-first-write',
          runtimeStageId: 'after-first-write#1',
          overwrite: { x: [0] },
          updates: {},
          trace: [
            { path: 'x', verb: 'set' },
            { path: 'x', verb: 'set' },
          ],
        },
      ],
    },
  };
  const current = { failed: FAILURE, ...structuredClone(before) } as any;
  current.snapshot.sharedState.x = '«undefined»';
  const stage = current.snapshot.executionTree.next;
  stage.stageReads.x = '«undefined»';
  stage.stageWrites.x = '«undefined»';
  stage.errors.stageExecutionError = FAILURE;
  stage.attention = [{ kind: 'error', reason: 'ERROR_RECORDED', evidence: ['errors:stageExecutionError'] }];
  current.snapshot.commitLog[1].overwrite.x = '«undefined»';
  current.snapshot.commitLog[1].trace.pop();
  const oldHash = createHash('sha256').update(print(before)).digest('hex');
  const hashes = `{\n  "other": "${'a'.repeat(64)}",\n  "readTiers": "${oldHash}"\n}\n`;
  const withoutAttention = (value: unknown) => {
    const copy = structuredClone(value) as any;
    delete copy.snapshot.executionTree.next.attention;
    return copy;
  };
  return { before, current, hashes, withoutAttention };
}

it('attributes the full named delta and changes only the one hash slot', () => {
  const f = example();
  const result = readTiersCandidate(print(f.before), print(f.current), f.hashes, f.withoutAttention);
  expect(result.changes.every(({ cause }) => typeof cause === 'string')).toBe(true);
  expect(result.candidatePinText).toBe(print(f.current));
  expect(result.newReadTiersHash).toBe(
    createHash('sha256')
      .update(print(f.withoutAttention(f.current)))
      .digest('hex'),
  );
  expect(result.candidateHashesText.replace(result.newReadTiersHash, String(result.oldReadTiersHash))).toBe(f.hashes);
});

it('admits an already adopted exact pin without changing bytes or inventing another delta', () => {
  const f = example();
  const first = readTiersCandidate(print(f.before), print(f.current), f.hashes, f.withoutAttention);
  const next = readTiersCandidate(print(f.current), print(f.current), first.candidateHashesText, f.withoutAttention);
  expect(next.changes).toEqual([]);
  expect(next.candidateHashesText).toBe(first.candidateHashesText);
  expect(next.candidatePinText).toBe(print(f.current));
});

it('refuses a historical pin and hash that do not actually join', () => {
  const f = example();
  const hashes = JSON.parse(f.hashes);
  hashes.readTiers = 'b'.repeat(64);
  expect(() => readTiersCandidate(print(f.before), print(f.current), print(hashes), f.withoutAttention)).toThrow(
    'historical readTiers pin and historical hash do not agree',
  );
});

it('refuses an unrelated changed byte rather than globally projecting it', () => {
  const f = example();
  f.current.snapshot.executionTree.name = 'unexpected-other-change';
  expect(() => readTiersCandidate(print(f.before), print(f.current), f.hashes, f.withoutAttention)).toThrow(
    'unattributed bytes',
  );
});

it('refuses projection that drops the actual error as well as attention', () => {
  const f = example();
  expect(() =>
    readTiersCandidate(print(f.before), print(f.current), f.hashes, (value) => {
      const copy = f.withoutAttention(value);
      delete copy.snapshot.executionTree.next.errors.stageExecutionError;
      return copy;
    }),
  ).toThrow('beyond its error attention');
});
