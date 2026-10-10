/**
 * One writer (C5): `foottrace/write` hands out the classes the engine writes a record with, and no
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
import type { CommitBundle, ExecutionTree } from 'foottrace';
import { causalChain, commitValueAt, formatCausalChain, keysReadFromExecutionTree, stateAt } from 'foottrace';
import type { RecordEncoding } from 'foottrace/write';
import { EventLog, RecordFrame, SharedMemory } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor, getSubtreeSnapshot } from '../../../../src';
import type { StepScope } from '../../../helpers/recordRun';
import { recordRun } from '../../../helpers/recordRun';

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

/** Only fields the record's readers consume; the engine's diagnostics stay on its own tree. */
function recordTree(node: ExecutionTree | undefined): ExecutionTree | undefined {
  if (!node) return undefined;
  return {
    id: node.id,
    runtimeStageId: node.runtimeStageId,
    ...(node.stageReads && { stageReads: node.stageReads }),
    ...(node.next && { next: recordTree(node.next) }),
  };
}

describe.each(['full', 'delta'] as const)('recordRun helper against the engine (%s)', (commitValues) => {
  it('namespaced fork writes and their repeat continuations match the engine', async () => {
    const chart = flowChart<any>(
      'Seed',
      (s) => {
        s.x = 1;
      },
      'seed',
    )
      .addListOfFunction([
        {
          id: 'a',
          name: 'A',
          fn: (s: any) => {
            s.a = s.x + 1;
          },
        },
        {
          id: 'b',
          name: 'B',
          fn: (s: any) => {
            s.b = s.x + 2;
          },
        },
      ])
      .build();
    const executor = new FlowChartExecutor(chart, { commitValues, writeProvenance: 'reads-prefix' });
    await executor.run();
    const helper = recordRun({}, { commitValues, writeProvenance: 'reads-prefix' });
    helper.step('seed', (s) => s.set('x', 1), { name: 'Seed' });
    helper.step('a', (s) => s.set('a', (s.read('x') as number) + 1), { name: 'A', address: ['runs', 'a'] });
    helper.step('b', (s) => s.set('b', (s.read('x') as number) + 2), { name: 'B', address: ['runs', 'b'] });
    helper.step('a', undefined, { name: 'A', address: ['runs', 'a'], phase: 'repeat' });
    helper.step('b', undefined, { name: 'B', address: ['runs', 'b'], phase: 'repeat' });
    const engine = executor.getSnapshot();
    expect(bytes(helper.snapshot().commitLog)).toBe(bytes(engine.commitLog));
    expect(helper.state.getState()).toEqual(engine.sharedState);
  });

  it('a subflow seed, prefixed stage, merge-back and exit match both engine logs', async () => {
    const inner = flowChart<any>(
      'Double',
      (s) => {
        s.doubled = s.given * 2;
      },
      'double',
    ).build();
    const chart = flowChart<any>(
      'Seed',
      (s) => {
        s.given = 21;
      },
      'seed',
    )
      .addSubFlowChartNext('sf', inner, 'Inner', {
        inputMapper: (p: any) => ({ given: p.given }),
        outputMapper: (s: any) => ({ doubled: s.doubled }),
      })
      .build();
    const executor = new FlowChartExecutor(chart, { commitValues });
    await executor.run();
    const helper = recordRun({}, { commitValues });
    helper.step('seed', (s) => s.set('given', 21), { name: 'Seed' });
    const sub = recordRun({}, { commitValues });
    sub.step('sf', (s) => s.set('given', helper.state.getState().given), { name: 'Inner', runtimeStageId: 'sf#1' });
    sub.step('sf/double', (s) => s.set('doubled', (s.read('given') as number) * 2), {
      name: 'sf/Double',
      runtimeStageId: 'sf/double#2',
    });
    helper.step('sf', (s) => s.set('doubled', sub.state.getState().doubled), { name: 'Inner' });
    helper.step('sf', undefined, { name: 'Inner', phase: 'exit' });
    const engine = executor.getSnapshot();
    const engineSub = getSubtreeSnapshot(engine, 'sf');
    expect(bytes(helper.snapshot().commitLog)).toBe(bytes(engine.commitLog));
    expect(bytes(sub.snapshot().commitLog)).toBe(bytes(engineSub?.history));
    expect(sub.snapshot().initialState).toEqual(engineSub?.initialState);
    expect(helper.state.getState()).toEqual(engine.sharedState);
  });

  it.each(['off', 'reads-prefix'] as const)(
    'same operations give the same bytes, read tree and reader answers (%s)',
    async (writeProvenance) => {
      const seed = { count: 0, history: ['seeded'], cfg: { n: 0, kept: true }, gone: 'remove' };
      type Operations = Pick<StepScope, 'read' | 'set' | 'merge' | 'delete'>;
      const steps: Array<{ id: string; name: string; body: (scope: Operations) => void }> = [
        {
          id: 'change',
          name: 'Change',
          body: (s) => {
            s.set('touched', true);
            // Read retention must keep n:0 even when this private borrowed value is edited before commit.
            const cfg = s.read('cfg') as { n: number; kept: boolean };
            cfg.n = 1;
            s.set('cfg', cfg);
            s.merge('cfg', { added: 2 });
            s.set('count', (s.read('count') as number) + 1);
            s.set('history', [...(s.read('history') as string[]), 'next']);
            s.delete('gone');
            s.set('secret', 'private', { whole: true });
          },
        },
        {
          id: 'unchanged',
          name: 'Unchanged',
          body: (s) => {
            s.set('count', s.read('count'));
            s.read('missing');
          },
        },
        { id: 'empty', name: 'Empty', body: () => {} },
        {
          id: 'finish',
          name: 'Finish',
          body: (s) => {
            s.set('result', s.read('n', ['cfg']));
            s.set('count', 2);
            s.set('count', 3);
          },
        },
      ];
      const bodyOf = (step: (typeof steps)[number]) => (scope: any) =>
        step.body({
          // The frame's explicit nested read is ScopeFacade.getValueAt(path, key).
          // TypedScope.$read instead reads its root proxy and reports the root key.
          read: (key, path = []) => scope.$toRaw().getValueAt(path, key),
          set: (key, value, scrub) => scope.$setValue(key, value, scrub?.whole),
          merge: (key, value) => scope.$update(key, value),
          delete: (key) => scope.$delete(key),
        });
      const builder = flowChart(steps[0].name, bodyOf(steps[0]), steps[0].id, { tags: ['change'] });
      for (const step of steps.slice(1)) builder.addFunction(step.name, bodyOf(step), step.id);
      const executor = new FlowChartExecutor(builder.build(), { initialContext: seed, commitValues, writeProvenance });
      await executor.run();
      const engine = executor.getSnapshot();

      const helper = recordRun(seed, { commitValues, writeProvenance });
      for (const [i, step] of steps.entries()) {
        helper.step(step.id, step.body, { name: step.name, ...(i === 0 && { tags: ['change'] }) });
      }
      const written = helper.snapshot();
      expect(bytes(written.commitLog)).toBe(bytes(engine.commitLog));
      expect(written.initialState).toEqual(engine.initialState);
      expect(helper.state.getState()).toEqual(engine.sharedState);
      expect(recordTree(written.executionTree)).toEqual(recordTree(engine.executionTree));
      expect(written.executionTree?.stageReads?.cfg).toEqual({ n: 0, kept: true });

      for (const [idx, bundle] of written.commitLog.entries()) {
        expect(stateAt(written, idx)).toEqual(stateAt(engine, idx));
        for (const key of ['cfg', 'count', 'history', 'gone', 'secret', 'result']) {
          expect(commitValueAt(written.commitLog, idx, key)).toEqual(commitValueAt(engine.commitLog, idx, key));
        }
        expect(keysReadFromExecutionTree(written.executionTree ?? {}).lookup(bundle.runtimeStageId)).toEqual(
          keysReadFromExecutionTree(engine.executionTree).lookup(bundle.runtimeStageId),
        );
      }
    },
  );
});
