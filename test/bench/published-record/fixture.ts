import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RecordEntry } from 'foottrace/write';
import { vi } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { _resetRunIdStateForTesting } from '../../../src/lib/runner/runId.js';
import { indexedFileSink } from '../../../src/sinks.js';

type Encoding = 'full' | 'delta';
type State = { shift?: string; privateLabel?: string; round: number; steps: number[] };

export async function capture(directory: string, encoding: Encoding, privateLabel: string) {
  const payload = join(directory, 'data.jsonl');
  const sidecar = join(directory, 'index.json');
  const sink = indexedFileSink(payload, { audience: 'scheduler' });
  const child = flowChart<State>(
    'Shift',
    (scope) => {
      scope.shift = 'morning';
    },
    'shift',
  ).build();
  const mount = { inputMapper: () => ({}), outputMapper: () => ({}) };
  const chart = flowChart<State>(
    'Start',
    (scope) => {
      scope.steps = [0];
      scope.round = 0;
    },
    'start',
  )
    .addFunction(
      'Round',
      (scope) => {
        scope.round += 1;
      },
      'round',
    )
    .addSubFlowChartNext('east', child, 'East', mount)
    .addFunction(
      'Midpoint',
      (scope) => {
        scope.steps = [...scope.steps, 1];
      },
      'midpoint',
    )
    .addSubFlowChartNext('west', child, 'West', mount)
    .addParallelForEach('Stations', 'stations', {
      items: () => ['north', 'south'],
      branch: () => child,
      into: 'stationResults',
      maxBranches: 2,
    })
    .addFunction(
      'Finish',
      (scope) => {
        scope.steps = [...scope.steps, 2];
        if (scope.round === 2) scope.$break();
      },
      'finish',
    )
    .loopTo('round')
    .build();

  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  _resetRunIdStateForTesting();
  try {
    const runner = new FlowChartExecutor(chart, {
      sink,
      commitValues: encoding,
      initialContext: { privateLabel },
    });
    runner.setRedactionPolicy({ keys: ['privateLabel'] });
    await runner.run();
    const publication = await sink.seal(sidecar);
    // Read the reference outside the timed operations. Address and byte span
    // come from the actual JSONL stream, independently of the sidecar.
    const data = readFileSync(payload, 'utf8');
    let offset = 0;
    const rows = data
      .trimEnd()
      .split('\n')
      .map((line) => {
        const row = JSON.parse(line) as RecordEntry;
        const bytes = Buffer.byteLength(line + '\n');
        const start = offset;
        offset += bytes;
        return { start, end: offset, row };
      });
    return { payload, sidecar, publication, rows };
  } finally {
    clock.mockRestore();
    await sink.close();
  }
}
