import type { RecordEncoding } from 'foottrace/write';

import { recordRun } from './recordRun';

/** The record of the three-turn history loop; its real-engine parity is pinned in commit-values.test.ts. */
export function growingHistoryRecord(commitValues: RecordEncoding['commitValues']) {
  const run = recordRun({}, { commitValues });
  run.step(
    'seed',
    (scope) => {
      scope.set('i', 0);
      scope.set('history', []);
    },
    { name: 'Seed' },
  );
  for (let turn = 0; turn < 3; turn++) {
    run.step(
      'work',
      (scope) => {
        const i = scope.read('i') as number;
        const history = scope.read('history') as unknown[];
        scope.set('history', [...history, { idx: i, text: `message-${i}` }]);
        scope.set('i', i + 1);
        // Display names captured from this chart's three visits, not a second loop scheduler.
      },
      { name: ['Work', 'Work', 'Work.1'][turn] },
    );
  }
  return run;
}
