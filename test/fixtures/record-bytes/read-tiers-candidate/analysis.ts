/** Read-only, one-scenario #124 pin analysis. Candidate bytes always come from the real run. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const UNDEFINED = '«undefined»';
const FAILURE = "TypeError: Cannot read properties of undefined (reading 'push')";
const ERROR_ATTENTION = [{ kind: 'error', reason: 'ERROR_RECORDED', evidence: ['errors:stageExecutionError'] }];
const CAUSES: Record<string, string> = {
  '/failed': 'same-stage deleted-key read leads to the already-proved scenario-owned TypeError',
  '/snapshot/sharedState/x': 'staged deletion remains undefined; no former [0] writeback',
  '/snapshot/executionTree/next/stageReads/x': 'deleted x is read as undefined in that stage',
  '/snapshot/executionTree/next/stageWrites/x': 'push throws before replacement write; staged deletion is retained',
  '/snapshot/executionTree/next/errors/stageExecutionError': 'the exact scenario TypeError is retained',
  '/snapshot/executionTree/next/attention': 'the exact error mark cites the retained stage error',
  '/snapshot/commitLog/1/overwrite/x': 'the commit retains deletion instead of former writeback',
  '/snapshot/commitLog/1/trace/1': 'the former second writeback never executes after push throws',
};
type JsonRecord = Record<string, any>;
type Side = { present: boolean; value?: unknown };
export type PathChange = { path: string; before: Side; after: Side; cause?: string };
const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
export const captureSha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Missing containers/array slots are one atomic path diff containing their FULL value. */
export function readTiersPathChanges(before: unknown, after: unknown): PathChange[] {
  const changes: PathChange[] = [];
  let nodes = 0;
  const visit = (a: Side, b: Side, path: string, depth: number): void => {
    assert.ok(++nodes <= 20_000 && depth <= 32, 'path-diff bound exceeded; no clipped report');
    if (a.present && b.present && JSON.stringify(a.value) === JSON.stringify(b.value)) return;
    const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';
    if (
      a.present &&
      b.present &&
      object(a.value) &&
      object(b.value) &&
      Array.isArray(a.value) === Array.isArray(b.value)
    ) {
      const keys = [...new Set([...Object.keys(a.value), ...Object.keys(b.value)])].sort();
      for (const key of keys)
        visit(
          { present: Object.hasOwn(a.value, key), value: a.value[key] },
          { present: Object.hasOwn(b.value, key), value: b.value[key] },
          `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
          depth + 1,
        );
      return;
    }
    assert.ok(changes.length < 64, 'path-diff count exceeded; no clipped report');
    changes.push({ path, before: a, after: b, cause: CAUSES[path] });
  };
  visit({ present: true, value: before }, { present: true, value: after }, '', 0);
  return changes;
}

/** Named current record witness; the permanent raw test independently proves its actual source frame. */
export function assertReadTiers124(current: JsonRecord): void {
  assert.equal(current.failed, FAILURE);
  assert.deepEqual(current.snapshot.sharedState, { x: UNDEFINED, y: [1] });
  const root = current.snapshot.executionTree;
  const stage = root.next;
  assert.equal(root.id, 'before-first-write');
  assert.equal(stage.id, 'after-first-write');
  assert.equal(stage.runtimeStageId, 'after-first-write#1');
  assert.deepEqual(stage.stageReads, { x: UNDEFINED });
  assert.deepEqual(stage.stageWrites, { x: UNDEFINED });
  assert.deepEqual(stage.errors, { stageExecutionError: FAILURE });
  assert.deepEqual(stage.attention, ERROR_ATTENTION);
  assert.equal(current.snapshot.commitLog.length, 2);
  const commit = current.snapshot.commitLog[1];
  assert.equal(commit.stageId, stage.id);
  assert.equal(commit.runtimeStageId, stage.runtimeStageId);
  assert.deepEqual(commit.overwrite, { x: UNDEFINED });
  assert.deepEqual(commit.updates, {});
  assert.deepEqual(commit.trace, [{ path: 'x', verb: 'set' }]);
}

/** Pure analysis; no pin/hash write, scenario execution, global projection or re-pin mode. */
export function readTiersCandidate(
  beforePinText: string,
  currentPinText: string,
  beforeHashesText: string,
  withoutAttention: (value: unknown) => unknown,
) {
  for (const input of [beforePinText, currentPinText, beforeHashesText])
    assert.ok(Buffer.byteLength(input) <= 256 * 1024, 'capture input bound exceeded');
  const before = JSON.parse(beforePinText) as JsonRecord;
  const current = JSON.parse(currentPinText) as JsonRecord;
  assertReadTiers124(current);
  const changes = readTiersPathChanges(before, current);
  if (changes.length) {
    assert.equal(Object.hasOwn(before, 'failed'), false, 'unexpected historical failure');
    const expected = { failed: FAILURE, ...structuredClone(before) } as JsonRecord;
    const stage = expected.snapshot.executionTree.next;
    const commit = expected.snapshot.commitLog[1];
    assert.deepEqual(expected.snapshot.sharedState.x, [0]);
    assert.deepEqual(stage.stageReads, { x: [] });
    assert.deepEqual(stage.stageWrites, { x: [0] });
    assert.deepEqual(stage.errors, {});
    assert.equal(Object.hasOwn(stage, 'attention'), false);
    assert.deepEqual(commit.overwrite, { x: [0] });
    assert.deepEqual(commit.trace, [
      { path: 'x', verb: 'set' },
      { path: 'x', verb: 'set' },
    ]);
    expected.snapshot.sharedState.x = UNDEFINED;
    stage.stageReads.x = UNDEFINED;
    stage.stageWrites.x = UNDEFINED;
    stage.errors.stageExecutionError = FAILURE;
    stage.attention = structuredClone(ERROR_ATTENTION);
    commit.overwrite.x = UNDEFINED;
    commit.trace.pop();
    assert.equal(text(expected), currentPinText, 'unattributed bytes beyond the eight named #124 changes');
    assert.deepEqual(changes.map(({ path }) => path).sort(), Object.keys(CAUSES).sort());
  } else assert.equal(beforePinText, currentPinText, 'unattributed formatting/key-order change');

  // Use the caller's ACTUAL existing projection, checking its exact effect here.
  const projected = withoutAttention(current);
  const expectedProjection = structuredClone(current);
  delete expectedProjection.snapshot.executionTree.next.attention;
  assert.equal(
    text(projected),
    text(expectedProjection),
    'readTiers projection changed anything beyond its error attention',
  );
  assert.equal(text(current), currentPinText, 'projection mutated the actual current record');
  const normalizedText = text(projected);
  const beforeHashes = JSON.parse(beforeHashesText) as Record<string, unknown>;
  assert.ok(Object.keys(beforeHashes).length <= 64 && Object.hasOwn(beforeHashes, 'readTiers'));
  for (const hash of Object.values(beforeHashes)) assert.match(String(hash), /^[a-f0-9]{64}$/u);
  assert.equal(
    captureSha256(text(withoutAttention(before))),
    beforeHashes.readTiers,
    'historical readTiers pin and historical hash do not agree',
  );
  const newHash = captureSha256(normalizedText);
  const slots = [...beforeHashesText.matchAll(/("readTiers"\s*:\s*")([a-f0-9]{64})(")/gu)];
  assert.equal(slots.length, 1, 'one literal readTiers hash slot required');
  const candidateHashesText = beforeHashesText.replace(
    /("readTiers"\s*:\s*")([a-f0-9]{64})(")/u,
    (_whole, prefix: string, _old: string, suffix: string) => `${prefix}${newHash}${suffix}`,
  );
  const afterHashes = JSON.parse(candidateHashesText) as Record<string, unknown>;
  assert.deepEqual({ ...afterHashes, readTiers: beforeHashes.readTiers }, beforeHashes);
  return {
    scenario: 'readTiers',
    law: '#124',
    changes,
    beforePinSha256: captureSha256(beforePinText),
    afterPinSha256: captureSha256(currentPinText),
    oldReadTiersHash: beforeHashes.readTiers,
    newReadTiersHash: newHash,
    candidatePinText: currentPinText,
    normalizedText,
    candidateHashesText,
  };
}
