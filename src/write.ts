/**
 * footprintjs/write — the public way to write a record.
 *
 * A record is what a run wrote: a frozen base and an append-only log of bundles, one per step
 * (docs/guides/record-contract.md). This door hands out the classes the engine itself writes one
 * with — there is no wrapper, so a record written here and one a flowchart wrote come from the same
 * code and the same bytes:
 *
 *   - `SharedMemory` — the heap: live state, one generation per commit (copy-on-write);
 *   - `EventLog`     — the log: the fold base and the bundles, frozen as they are recorded;
 *   - `RecordFrame`  — one step's frame: what it read (`read`, `noteRead`), what it staged
 *                      (`write`, with a redaction verdict's bytes as `WriteScrub`), and its
 *                      commit onto the heap and the log (`commit`, named by a `CommitStamp`).
 *
 * The step's encoding is two dials (`RecordEncoding`): `commitValues` (`'full'` | `'delta'`) and
 * `writeProvenance` (`'off'` | `'reads-prefix'`, `WriteProvenanceMode`).
 *
 * Every type this door names is the record's own: nothing here loads or names the engine
 * (test/architecture/write-door.test.ts). Its names and the bytes they write are promised under the
 * record fixtures' re-pin policy (test/fixtures/README.md): a refactor never moves a byte.
 *
 * @example
 * ```typescript
 * import { EventLog, RecordFrame, SharedMemory } from 'footprintjs/write';
 * import { stateAt } from 'footprintjs/trace';
 *
 * const state = new SharedMemory(undefined, { count: 0 }); // the heap, seeded
 * const log = new EventLog(state.getState());              // its fold base is the seed
 *
 * const frame = new RecordFrame(state, log);               // one step, at the root
 * frame.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix' });
 * const count = frame.read([], 'count') as number;
 * frame.noteRead([], 'count');                             // the bundle names the read
 * frame.write(frame.at([], 'count'), count + 1, 'set');
 * frame.commit(() => ({ stage: 'Increment', stageId: 'increment', runtimeStageId: 'increment#0' }));
 *
 * stateAt({ initialState: log.getInitialState(), commitLog: log.list() }, 0).state; // { count: 1 }
 * ```
 *
 * @module write
 */

// The heap and the log.
export { EventLog } from './lib/memory/EventLog.js';
export { SharedMemory } from './lib/memory/SharedMemory.js';

// One step's frame, and what it takes: the dials, the verbs, a verdict's bytes, the names on its bundle.
export type { CommitStamp } from './lib/memory/recordCommit.js';
export type { RecordEncoding, WriteScrub, WriteVerb } from './lib/memory/RecordFrame.js';
export { RecordFrame } from './lib/memory/RecordFrame.js';
export type { WriteProvenanceMode } from './lib/memory/types.js';
