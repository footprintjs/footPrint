/** Ordinary TypedScope expressions can opt into exact nested read evidence without rewriting workflow code. */
import { findLastWriter, keysReadFromExecutionTree, sliceForKey, sliceToJSON } from 'foottrace';
import { nativeGet, normaliseStateKey } from 'foottrace/paths';
import { describe, expect, it } from 'vitest';

import type { FlowChartExecutorOptions } from '../../../../src';
import { flowChart, FlowChartExecutor, getSubtreeSnapshot, select } from '../../../../src';
import { runPolicy } from '../../../../src/lib/memory/runPolicy';
import { createTypedScope } from '../../../../src/lib/reactive/createTypedScope';
import type { ReactiveTarget } from '../../../../src/lib/reactive/types';
import { ExecutionRuntime } from '../../../../src/lib/runner/ExecutionRuntime';

type State = Record<string, any>;
const at = (...segments: string[]) => normaliseStateKey(segments);
const capture = { nestedReadTracking: true, writeProvenance: 'reads-prefix' } as const;

function parallelChart() {
  return flowChart<State>(
    'LoadOrder',
    (scope) => {
      scope.unitPrice = 10;
      scope.quantity = 3;
      scope.deliveryFee = 5;
    },
    'load-order',
  )
    .addSelectorFunction(
      'RunCalculations',
      (scope) =>
        select(scope, [
          { when: () => true, then: 'items' },
          { when: () => true, then: 'delivery' },
        ]),
      'run-calculations',
    )
    .addFunctionBranch('items', 'Items', (scope) => {
      scope.amount = scope.unitPrice * scope.quantity;
    })
    .addFunctionBranch('delivery', 'Delivery', (scope) => {
      scope.amount = scope.deliveryFee;
    })
    .end()
    .addFunction(
      'Combine',
      (scope) => {
        scope.total = scope.runs.items.amount + scope.runs.delivery.amount;
      },
      'combine',
    )
    .build();
}

async function run(chart: ReturnType<typeof parallelChart>, options: FlowChartExecutorOptions = capture) {
  const executor = new FlowChartExecutor(chart, options);
  await executor.run();
  return executor.getSnapshot();
}

function totalReads(snapshot: Awaited<ReturnType<typeof run>>) {
  return snapshot.commitLog
    .find((bundle) => bundle.trace.some((row) => row.path === 'total'))!
    .trace.find((row) => row.path === 'total')!.readKeys;
}

describe('opt-in automatic nested read provenance', () => {
  it('links total35 to both real parallel branch leaves and their own inputs', async () => {
    const snapshot = await run(parallelChart());
    expect(snapshot.sharedState).toMatchObject({
      total: 35,
      runs: { items: { amount: 30 }, delivery: { amount: 5 } },
    });
    expect(snapshot.nestedReadTracking).toBe(true);
    expect(totalReads(snapshot)).toEqual([
      'runs',
      at('runs', 'items'),
      at('runs', 'items', 'amount'),
      at('runs', 'delivery'),
      at('runs', 'delivery', 'amount'),
    ]);
    expect(findLastWriter(snapshot.commitLog, at('runs', 'items', 'amount'))?.stageId).toBe('items');
    expect(findLastWriter(snapshot.commitLog, at('runs', 'delivery', 'amount'))?.stageId).toBe('delivery');
    const slice = sliceToJSON(
      sliceForKey(snapshot.commitLog, 'total', keysReadFromExecutionTree(snapshot.executionTree), {
        edgeAttribution: 'per-write',
      }),
    );
    expect(
      Object.values(slice.nodes)
        .map((node) => node.stageId)
        .sort(),
    ).toEqual(['combine', 'delivery', 'items', 'load-order']);
    expect(slice.edges.map((edge) => edge.key)).toEqual(
      expect.arrayContaining([
        at('runs', 'items', 'amount'),
        at('runs', 'delivery', 'amount'),
        'unitPrice',
        'quantity',
        'deliveryFee',
      ]),
    );
  });

  it('records actual branch-local addresses and root fallback paths without flattening namespaces', async () => {
    const chart = flowChart<State>(
      'Seed',
      (scope) => {
        scope.shared = { amount: 5 };
      },
      'seed',
    )
      .addSelectorFunction('Select', () => ['items'], 'select')
      .addFunctionBranch('items', 'Items', (scope) => {
        scope.local = { amount: 30 };
        scope.amount = scope.local.amount + scope.shared.amount;
      })
      .end()
      .addFunction(
        'Combine',
        (scope) => {
          scope.total = scope.runs.items.amount;
        },
        'combine',
      )
      .build();
    const snapshot = await run(chart);
    const branch = snapshot.commitLog.find((bundle) => bundle.stageId === 'items' && bundle.trace.length)!;
    expect(branch.trace.find((row) => row.path === at('runs', 'items', 'amount'))!.readKeys).toEqual([
      at('runs', 'items', 'local'),
      at('runs', 'items', 'local', 'amount'),
      'shared',
      at('shared', 'amount'),
    ]);
    expect(snapshot.sharedState.total).toBe(35);
  });

  it('keeps the legacy root-only read prefix and snapshot shape when omitted or disabled', async () => {
    for (const extra of [{}, { nestedReadTracking: false }]) {
      const snapshot = await run(parallelChart(), { writeProvenance: 'reads-prefix', ...extra });
      expect(snapshot.sharedState.total).toBe(35);
      expect(totalReads(snapshot)).toEqual(['runs']);
      expect(snapshot).not.toHaveProperty('nestedReadTracking');
    }
  });

  it('keeps literal dotted keys distinct from path segments and never adds reads after a write to its prefix', async () => {
    const chart = flowChart<State>(
      'Seed',
      (scope) => {
        scope.data = { 'a.b': 7, a: { b: 11 }, unused: 99 };
      },
      'seed',
    )
      .addFunction(
        'Read',
        (scope) => {
          scope.first = scope.data['a.b'];
          scope.total = scope.data.a.b;
          expect(scope.data.unused).toBe(99);
        },
        'read',
      )
      .build();
    const snapshot = await run(chart);
    const trace = snapshot.commitLog.find((bundle) => bundle.stageId === 'read')!.trace;
    expect(trace.find((row) => row.path === 'first')!.readKeys).toEqual(['data', at('data', 'a.b')]);
    expect(trace.find((row) => row.path === 'total')!.readKeys).toEqual([
      'data',
      at('data', 'a.b'),
      at('data', 'a'),
      at('data', 'a', 'b'),
    ]);
    expect(snapshot.sharedState).toMatchObject({ first: 7, total: 11 });
  });

  it('captures actual indexed member reads while JSON, guards and inspection add no nested reads', async () => {
    const chart = flowChart<State>(
      'Seed',
      (scope) => {
        scope.data = { amount: 30, other: 900 };
        scope.lines = [{ amount: 5 }];
      },
      'seed',
    )
      .addFunction(
        'Read',
        (scope) => {
          const data = scope.data;
          const lines = scope.lines;
          expect(data.then).toBeUndefined();
          expect(data.asymmetricMatch).toBeUndefined();
          expect(data.constructor).toBe(Object);
          expect(Object.keys(data)).toEqual(['amount', 'other']);
          expect(Object.getOwnPropertyDescriptor(data, 'other')).toBeDefined();
          expect(Reflect.has(data, 'other')).toBe(true);
          JSON.stringify(data);
          JSON.stringify(lines);
          scope.before = 1;
          scope.total = data.amount + lines[0].amount;
        },
        'read',
      )
      .build();
    const snapshot = await run(chart);
    const trace = snapshot.commitLog.find((bundle) => bundle.stageId === 'read')!.trace;
    expect(trace.find((row) => row.path === 'before')!.readKeys).toEqual(['data', 'lines']);
    expect(totalReads(snapshot)).toEqual([
      'data',
      'lines',
      at('data', 'amount'),
      at('lines', '0'),
      at('lines', '0', 'amount'),
    ]);
    expect(snapshot.sharedState.total).toBe(35);
  });

  it('does not invoke accessors during inspection or duplicate an actual accessor read', () => {
    let getterCalls = 0;
    const data = {
      get amount() {
        getterCalls++;
        return 35;
      },
      ordinary: 1,
    };
    const state: State = { data };
    const nested: string[][] = [];
    const target = {
      getValue: (key: string) => state[key],
      getValueSilent: (key: string) => state[key],
      getStateKeys: () => Object.keys(state),
    } as unknown as ReactiveTarget;
    const scope = createTypedScope<State>(target, {
      readNested: (path) => {
        nested.push([...path]);
        return 0;
      },
    });
    const held = scope.data;
    Object.keys(held);
    Object.getOwnPropertyDescriptor(held, 'amount');
    expect(held.then).toBeUndefined();
    expect(getterCalls).toBe(0);
    expect(held.amount).toBe(35);
    expect(getterCalls).toBe(1);
    expect(nested).toEqual([]);
  });

  it('preserves indexed accessor and array JSON values without extra getter calls or nested evidence', () => {
    let calls = 0;
    const lines = [0];
    Object.defineProperty(lines, '0', {
      configurable: true,
      enumerable: true,
      get: () => {
        calls++;
        return 35;
      },
    });
    const state: State = { lines };
    const paths: string[][] = [];
    const target = {
      getValue: (key: string) => state[key],
      getValueSilent: (key: string) => state[key],
      getStateKeys: () => Object.keys(state),
    } as unknown as ReactiveTarget;
    const scope = createTypedScope<State>(target, {
      readNested: (path) => {
        paths.push([...path]);
        return nativeGet(state, [...path]);
      },
    });
    const held = scope.lines;
    expect(JSON.stringify(held)).toBe('[35]');
    expect(calls).toBe(1);
    expect(held[0]).toBe(35);
    expect(calls).toBe(2);
    expect(paths).toEqual([]);
  });

  it('keeps an own undefined member without resolving a different root fallback value', () => {
    const state: State = { data: { amount: undefined } };
    let nestedReads = 0;
    const target = {
      getValue: (key: string) => state[key],
      getValueSilent: (key: string) => state[key],
      getStateKeys: () => Object.keys(state),
    } as unknown as ReactiveTarget;
    const scope = createTypedScope<State>(target, {
      readNested: () => {
        nestedReads++;
        return 35;
      },
    });
    expect(scope.data.amount).toBeUndefined();
    expect(nestedReads).toBe(0);
  });

  it('does work only along requested member paths without probing unrelated getters', () => {
    const data: State = { branch: { amount: 35 } };
    for (let i = 0; i < 500; i++)
      Object.defineProperty(data, `unused${i}`, {
        configurable: true,
        enumerable: true,
        get: () => {
          throw new Error('unrelated accessor must not run');
        },
      });
    const state: State = { data };
    const paths: string[][] = [];
    const target = {
      getValue: (key: string) => state[key],
      getValueSilent: (key: string) => state[key],
      getStateKeys: () => Object.keys(state),
    } as unknown as ReactiveTarget;
    const scope = createTypedScope<State>(target, {
      readNested: (path) => {
        paths.push([...path]);
        return nativeGet(state, [...path]);
      },
    });
    expect(scope.data.branch.amount).toBe(35);
    expect(paths).toEqual([
      ['data', 'branch'],
      ['data', 'branch', 'amount'],
    ]);
  });

  it('retains stale held-handle values without claiming they were read from a replaced path', async () => {
    const chart = flowChart<State>(
      'Seed',
      (scope) => {
        scope.data = { amount: 35 };
      },
      'seed',
    )
      .addFunction(
        'Read',
        (scope) => {
          const held = scope.data;
          scope.data = null;
          scope.total = held.amount;
        },
        'read',
      )
      .build();
    const snapshot = await run(chart);
    expect(snapshot.sharedState.total).toBe(35);
    expect(totalReads(snapshot)).toEqual(['data']);
  });

  it('uses existing retention and redaction at nested paths; off retains no read values', async () => {
    const chart = flowChart<State>(
      'Seed',
      (scope) => {
        scope.data = { amount: 35, public: 5 };
      },
      'seed',
    )
      .addFunction(
        'Read',
        (scope) => {
          scope.total = scope.data.amount;
        },
        'read',
      )
      .build();
    const executor = new FlowChartExecutor(chart, capture);
    executor.setRedactionPolicy({ fields: { data: ['amount'] } });
    await executor.run();
    const snapshot = executor.getSnapshot({ redact: true });
    const reads = snapshot.executionTree.next!.stageReads!;
    expect(reads['data.amount']).toBe('[REDACTED]');
    expect(reads.data).toMatchObject({ amount: '[REDACTED]', public: 5 });
    expect(totalReads(snapshot)).toContain(at('data', 'amount'));
    const off = await run(parallelChart(), { ...capture, readTracking: 'off' });
    expect(off.executionTree.next!.next!.stageReads).toBeUndefined();
    expect(totalReads(off)).toContain(at('runs', 'items', 'amount'));
  });

  it('retains live-root mapper read prefixes alongside captured child output handoffs', async () => {
    const child = flowChart<State>(
      'Work',
      (scope) => {
        scope.output = scope.input * 2;
      },
      'work',
    ).build();
    const chart = flowChart<State>(
      'Seed',
      (scope) => {
        scope.seed = 7;
        scope.bias = 21;
      },
      'seed',
    )
      .addSubFlowChartNext('child', child, 'Child', {
        inputMapper: (parent: State) => ({ input: parent.seed }),
        outputMapper: (childState: State, parent: State) => ({ total: childState.output + parent.bias }),
      })
      .build();
    const snapshot = await run(chart, { ...capture, captureOutputHandoff: true });
    expect(snapshot.sharedState.total).toBe(35);
    expect(totalReads(snapshot)).toEqual(['seed', 'bias']);
    const result = Object.values(snapshot.subflowResults!)[0];
    expect(result).toMatchObject({ outputHandoff: { writes: [{ path: 'total', reads: ['output'] }] } });
  });

  it('propagates the opt-in into a child log while keeping its address separate', async () => {
    const child = flowChart<State>(
      'Child seed',
      (scope) => {
        scope.data = { amount: 35 };
      },
      'seed',
    )
      .addFunction(
        'Child read',
        (scope) => {
          scope.total = scope.data.amount;
        },
        'read',
      )
      .build();
    const chart = flowChart<State>('Start', () => {}, 'start')
      .addSubFlowChartNext('child', child, 'Child', { outputMapper: (state: State) => ({ total: state.total }) })
      .build();
    const snapshot = await run(chart);
    const childLog = getSubtreeSnapshot(snapshot, 'child')!;
    const output = childLog.history.find((bundle) => bundle.trace.some((row) => row.path === 'total'))!;
    expect(output.trace.find((row) => row.path === 'total')!.readKeys).toEqual(['data', at('data', 'amount')]);
    expect(snapshot.sharedState.total).toBe(35);
  });

  it('keeps exact prefixes when source identity is unavailable, without promoting source coverage', () => {
    const runtime = new ExecutionRuntime(
      'Read',
      'read',
      undefined,
      { data: { amount: 35 } },
      runPolicy({ ...capture, readSources: true }),
      undefined,
      { runId: 'missing-identity', unavailable: 'identity-unavailable' },
    );
    const context = runtime.rootStageContext;
    const amount = context.getValue(['data'], 'amount');
    context.setGlobal('total', amount);
    context.commit();
    const snapshot = runtime.getSnapshot();
    expect(snapshot.sharedState.total).toBe(35);
    expect(snapshot.commitLog[0].trace.find((row) => row.path === 'total')!.readKeys).toEqual([at('data', 'amount')]);
    expect(snapshot.readSources!.status).not.toBe('captured');
    expect(snapshot.readSources!.limitations).toContain('identity-unavailable');
  });

  it('keeps one immutable nested-read encoding per log while other policy dials can change', () => {
    const policy = runPolicy(capture);
    expect(Object.isFrozen(policy)).toBe(true);
    const runtime = new ExecutionRuntime('Root', 'root', undefined, undefined, policy);
    const next = runPolicy({ ...capture, readTracking: 'off' });
    runtime.usePolicy(next);
    expect(runtime.rootStageContext.getPolicy()).toBe(next);
    expect(() => runtime.usePolicy(runPolicy({ nestedReadTracking: false }))).toThrow('cannot change within a log');
    expect(runtime.rootStageContext.getPolicy()).toBe(next);
    expect(runtime.getSnapshot().nestedReadTracking).toBe(true);
    expect(new ExecutionRuntime('Fresh', 'fresh').getSnapshot()).not.toHaveProperty('nestedReadTracking');
  });

  it.each([false, true])(
    'preserves capture encoding across actual pause/resume (nested=%s)',
    async (nestedReadTracking) => {
      const chart = flowChart<State>(
        'Seed',
        (scope) => {
          scope.data = { amount: 35 };
        },
        'seed',
      )
        .addFunction(
          'Before',
          (scope) => {
            scope.before = scope.data.amount;
          },
          'before',
        )
        .addPausableFunction(
          'Pause',
          { execute: async () => ({ question: 'continue?' }), resume: async () => {} },
          'pause',
        )
        .addFunction(
          'After',
          (scope) => {
            scope.total = scope.data.amount;
          },
          'after',
        )
        .build();
      const executor = new FlowChartExecutor(chart, { ...capture, nestedReadTracking });
      await executor.run();
      const paused = executor.getSnapshot();
      const recorded = paused.commitLog.map((bundle) => bundle.runtimeStageId);
      const checkpoint = JSON.parse(JSON.stringify(executor.getCheckpoint()));
      await executor.resume(checkpoint, true);
      const snapshot = executor.getSnapshot();
      expect(snapshot.sharedState.total).toBe(35);
      expect(snapshot.commitLog.slice(0, recorded.length).map((bundle) => bundle.runtimeStageId)).toEqual(recorded);
      expect(totalReads(snapshot)).toEqual(nestedReadTracking ? ['data', at('data', 'amount')] : ['data']);
      expect(snapshot.nestedReadTracking).toBe(nestedReadTracking ? true : undefined);
    },
  );

  it('keeps native scalar read-source capture bounded and partial for unsupported nested/container reads', async () => {
    const snapshot = await run(parallelChart(), {
      ...capture,
      readTracking: 'off',
      readSources: { limits: { maxOccurrences: 2, maxPerExecution: 2 } },
    });
    expect(snapshot.readSources!.record!.occurrences.length).toBeLessThanOrEqual(2);
    expect(snapshot.readSources!.status).toBe('partial');
    expect(totalReads(snapshot)).toContain(at('runs', 'items', 'amount'));
    expect(snapshot.sharedState.total).toBe(35);
  });
});
