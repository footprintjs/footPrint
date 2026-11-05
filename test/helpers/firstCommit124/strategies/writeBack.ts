import { equal, refuse } from '../../readLawWitness.js';
import type { BranchPlan, Context } from '../types.js';
import { args } from '../valueFacts.js';
import { declaredWriteBackEdit } from './declaredEdit.js';

/** Existing delReadBack body only. Returns declared rows, never a cause or native-producer approval. */
export function writeBackStrategy(context: Context): BranchPlan {
  const {
    op,
    reads: [x, y],
    cause: { baseline: old, build: now },
  } = context;
  if (
    op.t !== 'delReadBack' ||
    typeof op.k !== 'string' ||
    typeof op.n !== 'number' ||
    !Number.isFinite(op.n) ||
    (op.how !== 'set' && op.how !== 'merge')
  )
    return refuse('no closed delReadBack object/write branch');
  if (old.calls.length !== 3 || now.calls.length !== 2 || old.edits.length !== 1 || now.edits.length !== 1)
    return refuse('old/new branch did not make exact declared call/edit count');
  const [delA, readA, writeA] = old.calls;
  const [delB, readB] = now.calls;
  const deletion = args(old.path, op.k, undefined, false, undefined, 'delete');
  const reading = args(old.path, op.k);
  if (
    delA.method !== 'setObject' ||
    delB.method !== 'setObject' ||
    !equal(delA.call.args, deletion) ||
    !equal(delB.call.args, deletion) ||
    readA.id !== x.read.id ||
    readB.id !== y.read.id ||
    !equal(readA.call.args, reading) ||
    !equal(readB.call.args, reading) ||
    writeA.method !== (op.how === 'set' ? 'setObject' : 'updateObject') ||
    writeA.call.args.length !== 3 ||
    !equal(writeA.call.args.slice(0, 2), reading)
  )
    return refuse('actual call arguments differ from declared write-back branch');
  const edit = old.edits[0];
  if (
    edit.outcome !== 'returned' ||
    x.read.resultObject === undefined ||
    edit.object !== x.read.resultObject ||
    edit.n !== op.n ||
    !(readA.end < edit.start && edit.start < edit.end && edit.end < writeA.start) ||
    writeA.call.objects[2] !== edit.object ||
    !equal(edit.before, x.read.result) ||
    !equal(edit.after, writeA.call.args[2])
  )
    return refuse('edit/write does not use that SAME returned object');
  declaredWriteBackEdit(edit.before, op.n, edit.after);
  const skipped = now.edits[0];
  if (
    skipped.outcome !== 'returned' ||
    skipped.object !== undefined ||
    skipped.n !== op.n ||
    skipped.before.kind !== 'undefined' ||
    skipped.after.kind !== 'undefined' ||
    !(readB.end < skipped.start && skipped.start < skipped.end && skipped.end < now.operation.end)
  )
    return refuse('build did not execute unchanged no-object edit branch');
  return {
    kind: 'declared-branches',
    strategy: 'writeback-del-readback',
    baselineWrites: [delA, writeA],
    buildWrites: [delB],
  };
}
