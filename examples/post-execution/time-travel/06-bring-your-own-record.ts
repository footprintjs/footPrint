/**
 * Bring your own record — time travel with no executor in the room.
 *
 * The reader's contract (docs/guides/record-contract.md): a frozen base, an
 * append-only log of bundles, four verbs, one address per bundle. This
 * record is written BY HAND — the way a workflow engine, a state machine or
 * a batch job that is not footprintjs would write it — and the cursor, the
 * fold, the tag axis and the gap report all work on it unchanged.
 *
 * The gap for an unknown verb is footprintjs 9.27.0's reader; run against an
 * older package the third section shows the old silent merge instead.
 */
import { stateAt, tagStops, timeTravel } from 'footprintjs/trace';

const record = {
  initialState: { count: 0, items: [] as number[], profile: { name: 'a' } },
  commitLog: [
    { runtimeStageId: 'seed#0', trace: [{ path: 'count', verb: 'set' }], overwrite: { count: 1 } },
    {
      runtimeStageId: 'grow#1',
      trace: [{ path: 'items', verb: 'append' }],
      overwrite: { items: [10] },
      tags: ['milestone:step'],
    },
    { runtimeStageId: 'enrich#2', trace: [{ path: 'profile', verb: 'merge' }], updates: { profile: { age: 3 } } },
    {
      runtimeStageId: 'forget#3',
      trace: [{ path: 'count', verb: 'delete' }],
      overwrite: { count: undefined },
      tags: ['milestone:step'],
    },
  ],
};

console.log('=== The fold at every stop (base + bundles up to it) ===\n');
const cursor = timeTravel(record);
for (const stop of cursor.stops) {
  const folded = cursor.stateAt(stop);
  console.log(
    `  ${stop.kind.padEnd(5)} ${(stop.runtimeStageId || '').padEnd(9)} through #${
      folded.throughCommitIdx
    }  ${JSON.stringify(folded.state)}  basis=${folded.basis}`,
  );
}

console.log('\n=== A tag axis, from the bundles alone — no execution tree ===\n');
const tagged = timeTravel(record, { strategy: tagStops(['milestone:step']) });
console.log(
  `  stops: ${tagged.stops.map((s) => `${s.kind}${s.kind === 'commit' ? `@${s.commitIdx}` : ''}`).join(' → ')}`,
);

console.log('\n=== A bundle the reader cannot read is a GAP, with its reason — the rest still folds ===\n');
const damaged = {
  ...record,
  commitLog: [
    record.commitLog[0],
    { ...record.commitLog[1], trace: [{ path: 'items', verb: 'upsert' }] },
    record.commitLog[2],
    record.commitLog[3],
  ],
};
const folded = stateAt(damaged, 3);
console.log(`  skipped: ${JSON.stringify(folded.skipped)}`);
console.log(`  state:   ${JSON.stringify(folded.state)}`);
