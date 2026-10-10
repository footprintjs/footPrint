/**
 * Write a record — the record layer, with no executor in the room.
 *
 * `foottrace/write` hands out the classes the engine itself writes a record with:
 * the heap (`SharedMemory`), the log (`EventLog`) and one step's frame (`RecordFrame`).
 * There is no wrapper, so a record written here comes from the same code — and the same
 * bytes — as one a flowchart wrote, and every reader on `footprintjs/trace` reads it.
 *
 * One step = one frame = one bundle: read (and name what you read), write (with a
 * redaction verdict's bytes when a value is secret), commit under the step's names.
 * The record contract: docs/guides/record-contract.md ("Writing a record").
 */
import { causalChain, commitValueAt, formatCausalChain, stateAt } from 'foottrace';
import { EventLog, RecordFrame, SharedMemory } from 'foottrace/write';
import type { RecordEncoding } from 'foottrace/write';

const state = new SharedMemory(undefined, { count: 0 }); // the heap, seeded
const log = new EventLog(state.getState()); // the log; its fold base is the seed
const encoding: RecordEncoding = { commitValues: 'full', writeProvenance: 'reads-prefix' };

/** One step: read `count`, write it back incremented, and stamp the bundle with the step's names. */
function step(stageId: string, index: number, token?: string) {
  const frame = new RecordFrame(state, log); // at the root address
  frame.useEncoding(encoding);
  const count = frame.read([], 'count') as number;
  frame.noteRead([], 'count'); // the bundle's rows name the read (readKeys)
  frame.write(frame.at([], 'count'), count + 1, 'set');
  if (token !== undefined) frame.write(frame.at([], 'token'), token, 'set', { whole: true }); // the log shows 'REDACTED'
  frame.commit(() => ({ stage: stageId, stageId, runtimeStageId: `${stageId}#${index}` }));
}

step('sign-in', 0, 's3cret');
step('increment', 1);

const record = { initialState: log.getInitialState(), commitLog: log.list() };

console.log('=== The log: one bundle per step ===\n');
for (const bundle of record.commitLog) {
  console.log(`  ${bundle.runtimeStageId}  overwrite=${JSON.stringify(bundle.overwrite)}`);
  console.log(`    rows: ${JSON.stringify(bundle.trace)}  redacted: ${JSON.stringify(bundle.redactedPaths)}`);
}

console.log('\n=== The heap keeps the value; the record keeps the placeholder ===\n');
console.log(`  heap:    ${JSON.stringify(state.getState())}`);
console.log(`  fold @1: ${JSON.stringify(stateAt(record, 1).state)}  basis=${stateAt(record, 1).basis}`);
console.log(`  count at commit 0: ${JSON.stringify(commitValueAt(record.commitLog, 0, 'count'))}`);

console.log('\n=== Every reader works on it: who made count what it is? ===\n');
const dag = causalChain(record.commitLog, 'increment#1', () => ['count'], { edgeAttribution: 'per-write' });
console.log(dag ? formatCausalChain(dag) : '  (no chain)');
