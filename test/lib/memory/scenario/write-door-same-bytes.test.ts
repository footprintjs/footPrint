/**
 * One writer (C5): `footprintjs/write` hands out the classes the engine writes a record with, and no
 * wrapper — so the same steps written through the door and run as a flowchart give the same record,
 * byte for byte, and every reader answers the same on both.
 *
 *   scenario     two steps — a secret written under a redaction verdict, then a tracked read of `count`
 *                and a write back — as a flowchart (TypedScope, the executor) and as two `RecordFrame`s
 *                over a `SharedMemory` and an `EventLog`: the same commit log (JSON, key order kept)
 *                and the same fold base, under both `commitValues` encodings and `'reads-prefix'`
 *   integration  the readers on `footprintjs/trace` read the hand-written record as they read the
 *                engine's: `stateAt`, `commitValueAt`, `causalChain`
 *   boundary     the heap keeps the secret; the log and the fold keep the placeholder
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src';
import type { CommitBundle } from '../../../../src/trace';
import { causalChain, commitValueAt, formatCausalChain, stateAt } from '../../../../src/trace';
import type { RecordEncoding } from '../../../../src/write';
import { EventLog, RecordFrame, SharedMemory } from '../../../../src/write';

type Mode = 'full' | 'delta';
interface State {
  count: number;
  history: string[];
  token?: string;
}
const SEED: State = { count: 0, history: ['seeded'] };

/** The steps as a flowchart: the engine's frames, under the executor's run policy. */
async function asFlowchart(commitValues: Mode) {
  const chart = flowChart<State>(
    'Sign in',
    (scope) => {
      scope.$setValue('token', 's3cret', true);
      scope.history = [...scope.history, 'signed-in'];
    },
    'sign-in',
  )
    .addFunction(
      'Increment',
      (scope) => {
        scope.count = scope.count + 1;
      },
      'increment',
    )
    .build();
  const executor = new FlowChartExecutor(chart, {
    initialContext: structuredClone(SEED),
    commitValues,
    writeProvenance: 'reads-prefix',
  });
  await executor.run();
  const snapshot = executor.getSnapshot();
  return { commitLog: snapshot.commitLog, initialState: snapshot.initialState };
}

/** The same steps through the door: one `RecordFrame` per step over one heap and one log. */
function throughTheDoor(commitValues: Mode) {
  const state = new SharedMemory(undefined, structuredClone(SEED));
  const log = new EventLog(state.getState());
  const encoding: RecordEncoding = { commitValues, writeProvenance: 'reads-prefix' };

  const signIn = new RecordFrame(state, log);
  signIn.useEncoding(encoding);
  signIn.write(signIn.at([], 'token'), 's3cret', 'set', { whole: true });
  const history = signIn.read([], 'history') as string[];
  signIn.noteRead([], 'history');
  signIn.write(signIn.at([], 'history'), [...history, 'signed-in'], 'set');
  signIn.commit(() => ({ stage: 'Sign in', stageId: 'sign-in', runtimeStageId: 'sign-in#0' }));

  const increment = new RecordFrame(state, log);
  increment.useEncoding(encoding);
  const count = increment.read([], 'count') as number;
  increment.noteRead([], 'count');
  increment.write(increment.at([], 'count'), count + 1, 'set');
  increment.commit(() => ({ stage: 'Increment', stageId: 'increment', runtimeStageId: 'increment#1' }));

  return { commitLog: log.list(), initialState: log.getInitialState(), heap: state.getState() };
}

const bytes = (value: unknown) => JSON.stringify(value);

describe.each<Mode>(['full', 'delta'])("one writer — commitValues: '%s'", (mode) => {
  it('the door and the engine write the same commit log and the same fold base', async () => {
    const engine = await asFlowchart(mode);
    const door = throughTheDoor(mode);
    expect(door.commitLog).toHaveLength(2);
    expect(bytes(door.commitLog)).toBe(bytes(engine.commitLog));
    expect(bytes(door.initialState)).toBe(bytes(engine.initialState));
  });

  it('the readers on /trace answer the same on both records', async () => {
    const engine = await asFlowchart(mode);
    const door = throughTheDoor(mode);
    const read = (record: { commitLog: CommitBundle[]; initialState?: Record<string, unknown> }) => {
      const dag = causalChain(record.commitLog, 'increment#1', () => ['count'], { edgeAttribution: 'per-write' });
      return {
        folded: stateAt(record, 1).state,
        history: commitValueAt(record.commitLog, 0, 'history'),
        chain: dag ? formatCausalChain(dag) : undefined,
      };
    };
    expect(read(door)).toEqual(read(engine));
    expect(read(door).chain).toBeDefined();
  });

  it('the heap keeps the secret; the log and the fold keep the placeholder', () => {
    const door = throughTheDoor(mode);
    expect(door.heap.token).toBe('s3cret');
    expect(door.commitLog[0].overwrite.token).toBe('REDACTED');
    expect(door.commitLog[0].redactedPaths).toEqual(['token']);
    expect(stateAt(door, 1).state.token).toBe('REDACTED');
    expect(door.commitLog[1].trace.map((row) => row.readKeys)).toEqual([['count']]);
  });
});
