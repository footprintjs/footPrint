/**
 * A mapped child value keeps the identity of the child log it was observed in.
 * These tests run real charts: no child keys are flattened into the parent's
 * state-key namespace, and a reader resolves the saved child cutoff separately.
 */
import { findLastWriter, keysReadFromExecutionTree, sliceForKey, sliceToJSON } from 'foottrace';
import { describe, expect, it } from 'vitest';

import type { FlowChartExecutorOptions } from '../../../../src';
import { flowChart, FlowChartExecutor } from '../../../../src';

type State = Record<string, any>;
type Mapper = (child: State, parent: State) => State;
type Snapshot = ReturnType<FlowChartExecutor['getSnapshot']>;

const captureOptions = {
  captureOutputHandoff: true,
  writeProvenance: 'reads-prefix',
} satisfies FlowChartExecutorOptions;

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a recorded value');
  return value;
}

function childWith(base = 7) {
  return flowChart<State>(
    'Child seed',
    (scope) => {
      scope.localSource = base;
    },
    'seed',
  )
    .addFunction(
      'Child compute',
      (scope) => {
        scope.localOutput = scope.localSource * 2;
      },
      'compute',
    )
    .build();
}

function chartWith(mapper: Mapper = (child) => ({ renamed: child.localOutput }), child = childWith()) {
  return flowChart<State>('Parent start', () => {}, 'start')
    .addSubFlowChartNext('child', child, 'Child', { outputMapper: mapper })
    .addFunction(
      'Parent use',
      (scope) => {
        scope.final = scope.renamed + 1;
      },
      'use',
    )
    .build();
}

async function run(chart = chartWith(), options: FlowChartExecutorOptions = {}) {
  const executor = new FlowChartExecutor(chart, { ...captureOptions, ...options });
  await executor.run();
  return { executor, snapshot: executor.getSnapshot() };
}

function resultFor(snapshot: Snapshot, mountRuntimeStageId: string): any {
  const result = snapshot.subflowResults?.[mountRuntimeStageId];
  expect(result, `missing result for ${mountRuntimeStageId}`).toBeDefined();
  return result;
}

/** Check both ends against their actual records, then let foottrace resolve the child's writer. */
function handoffFor(snapshot: Snapshot, outputKey = 'renamed', sourceKeys = ['localOutput'], runtimeStageId?: string) {
  const parentCommit = snapshot.commitLog.find(
    (bundle) =>
      (runtimeStageId === undefined || bundle.runtimeStageId === runtimeStageId) &&
      bundle.trace.some((row) => row.path === outputKey),
  );
  if (parentCommit === undefined) throw new Error(`missing merge-back for ${outputKey}`);
  const result = resultFor(snapshot, parentCommit.runtimeStageId);
  const handoff = result.outputHandoff;
  expect(handoff).toEqual({
    version: 1,
    attribution: 'observed-read-prefix',
    parent: {
      address: snapshot.logAddress,
      runtimeStageId: parentCommit.runtimeStageId,
      commitIdx: parentCommit.idx,
    },
    child: { address: result.treeContext.logAddress, beforeCommitIdx: result.treeContext.history.length },
    writes: [{ path: outputKey, reads: sourceKeys }],
    status: 'captured',
    limitations: [],
  });
  expect(handoff.child.address.drillPath).toEqual([
    ...(handoff.parent.address.drillPath as string[]),
    parentCommit.runtimeStageId,
  ]);
  expect(handoff.parent.address.logRunId).toBe(handoff.child.address.logRunId);
  expect(parentCommit.trace.find((row) => row.path === outputKey)?.readKeys ?? []).not.toContain('localOutput');
  for (const key of sourceKeys) {
    const writer = findLastWriter(result.treeContext.history, key, handoff.child.beforeCommitIdx);
    expect(writer, `missing child writer for ${key}`).toBeDefined();
  }
  return { handoff, parentCommit, child: result.treeContext };
}

describe('subflow output handoff provenance', () => {
  it('a renamed output links to the child writer and its recorded reads', async () => {
    const { snapshot } = await run();
    expect(snapshot.sharedState.final).toBe(15);
    const { child, handoff } = handoffFor(snapshot);
    const slice = sliceForKey(
      child.history,
      handoff.writes[0].reads[0],
      keysReadFromExecutionTree(child.stageContexts),
      {
        before: handoff.child.beforeCommitIdx,
      },
    );
    const projected = sliceToJSON(slice);
    expect(Object.values(projected.nodes).map((node) => node.stageId)).toEqual(['child/compute', 'child/seed']);
    expect(projected.edges.map((edge) => edge.key)).toEqual(['localSource']);
    expect(slice.notes).toBeUndefined();
  });

  it('a mapper that returns a constant without reading the child has no child dependency', async () => {
    const { snapshot } = await run(chartWith(() => ({ renamed: 99 })));
    expect(snapshot.sharedState.final).toBe(100);
    handoffFor(snapshot, 'renamed', []);
  });

  it('a failed child does not hand back the writes it committed on its error path', async () => {
    const failure = new Error('child failed');
    const child = flowChart<State>(
      'Fail',
      (scope) => {
        scope.localOutput = 14;
        throw failure;
      },
      'fail',
    ).build();
    const executor = new FlowChartExecutor(chartWith(undefined, child), captureOptions);
    await expect(executor.run()).rejects.toBe(failure);
    const snapshot = executor.getSnapshot();
    expect(snapshot.commitLog.some((bundle) => bundle.trace.some((row) => row.path === 'renamed'))).toBe(false);
    for (const result of Object.values(snapshot.subflowResults ?? {}) as any[]) {
      expect(result.outputHandoff).toBeUndefined();
    }
  });

  it('a mapper that throws after reading the child has no successful handoff', async () => {
    const { snapshot } = await run(
      chartWith((child) => {
        const observed = child.localOutput;
        throw new Error(`mapper failed after reading ${observed}`);
      }),
    );
    expect(snapshot.commitLog.some((bundle) => bundle.trace.some((row) => row.path === 'renamed'))).toBe(false);
    for (const result of Object.values(snapshot.subflowResults ?? {}) as any[]) {
      expect(result.outputHandoff).toBeUndefined();
    }
  });

  it('a retried child links to the successful attempt rather than discarded reads', async () => {
    let attempts = 0;
    const child = flowChart<State>(
      'Child seed',
      (scope) => {
        scope.failedSource = 50;
        scope.actualSource = 7;
      },
      'seed',
    )
      .addFunction(
        'Child compute',
        (scope) => {
          if (++attempts === 1) {
            scope.localOutput = scope.failedSource * 2;
            throw new Error('try again');
          }
          scope.localOutput = scope.actualSource * 2;
        },
        'compute',
      )
      .retry({ attempts: 2, backoffMs: 0 })
      .build();
    const { snapshot } = await run(chartWith(undefined, child));
    const { child: record } = handoffFor(snapshot);
    const writer = required(findLastWriter(record.history, 'localOutput'));
    expect(writer.trace.find((row) => row.path === 'localOutput')?.readKeys).toEqual(['actualSource']);
    expect(attempts).toBe(2);
    expect(snapshot.sharedState.final).toBe(15);
  });
  it('each nested handoff names the adjacent child log, never a flattened root key', async () => {
    const middle = flowChart<State>('Middle start', () => {}, 'start')
      .addSubFlowChartNext('inner', childWith(), 'Inner', {
        outputMapper: (child: State) => ({ middleOutput: child.localOutput }),
      })
      .build();
    const { snapshot } = await run(chartWith((child) => ({ renamed: child.middleOutput }), middle));
    const outer = handoffFor(snapshot, 'renamed', ['middleOutput']);
    const inner = handoffFor(
      {
        commitLog: outer.child.history,
        logAddress: outer.child.logAddress,
        subflowResults: snapshot.subflowResults,
      } as Snapshot,
      'middleOutput',
    );
    expect(inner.handoff.parent.address).toEqual(outer.handoff.child.address);
    expect(inner.handoff.child.address.drillPath).toHaveLength(2);
    expect(snapshot.sharedState.final).toBe(15);
  });

  it('repeated executions of the same mount keep separate child addresses and cutoffs', async () => {
    const child = flowChart<State>(
      'Child seed',
      (scope) => {
        scope.localSource = scope.iteration;
      },
      'seed',
    )
      .addFunction(
        'Child compute',
        (scope) => {
          scope.localOutput = scope.localSource * 2;
        },
        'compute',
      )
      .build();
    const chart = flowChart<State>(
      'Start',
      (scope) => {
        scope.count = 0;
      },
      'start',
    )
      .addFunction(
        'Tick',
        (scope) => {
          scope.count += 1;
        },
        'tick',
      )
      .addSubFlowChartNext('child', child, 'Child', {
        inputMapper: (parent: State) => ({ iteration: parent.count }),
        outputMapper: (output: State) => ({ renamed: output.localOutput }),
      })
      .addFunction(
        'Gate',
        (scope) => {
          if (scope.count === 2) scope.$break();
        },
        'gate',
      )
      .loopTo('tick')
      .build();
    const { snapshot } = await run(chart);
    const merges = snapshot.commitLog.filter((bundle) => bundle.trace.some((row) => row.path === 'renamed'));
    expect(merges).toHaveLength(2);
    const handoffs = merges.map((bundle) => handoffFor(snapshot, 'renamed', ['localOutput'], bundle.runtimeStageId));
    expect(handoffs.map(({ child }) => child.globalContext.localOutput)).toEqual([2, 4]);
    expect(new Set(handoffs.map(({ handoff }) => JSON.stringify(handoff.child.address))).size).toBe(2);
    expect(snapshot.sharedState.renamed).toBe(4);
  });

  it("parallel children with the same local keys cannot claim one another's output", async () => {
    const chart = flowChart<State>('Start', () => {}, 'start')
      .addSelectorFunction('Both', () => ['left', 'right'], 'both')
      .addSubFlowChartBranch('left', childWith(7), 'Left', {
        outputMapper: (output: State) => ({ leftResult: output.localOutput }),
      })
      .addSubFlowChartBranch('right', childWith(13), 'Right', {
        outputMapper: (output: State) => ({ rightResult: output.localOutput }),
      })
      .end()
      .build();
    const { snapshot } = await run(chart);
    const left = handoffFor(snapshot, 'leftResult');
    const right = handoffFor(snapshot, 'rightResult');
    expect(left.handoff.child.address).not.toEqual(right.handoff.child.address);
    expect(left.child.globalContext.localOutput).toBe(14);
    expect(right.child.globalContext.localOutput).toBe(26);
    expect(snapshot.sharedState).toEqual({ leftResult: 14, rightResult: 26 });
  });

  it.each(['full', 'summary', 'off'] as const)(
    'child observations do not depend on readTracking: %s',
    async (readTracking) => {
      const { snapshot } = await run(chartWith(), { readTracking });
      const { child } = handoffFor(snapshot);
      const reads = keysReadFromExecutionTree(child.stageContexts);
      const writer = required(findLastWriter(child.history, 'localOutput'));
      expect(reads.lookup(writer.runtimeStageId)).toEqual(readTracking === 'off' ? [] : ['localSource']);
      expect(snapshot.sharedState.final).toBe(15);
    },
  );

  it('does not add handoff metadata when capture is disabled', async () => {
    const { snapshot } = await run(chartWith(), { captureOutputHandoff: false });
    expect(snapshot.sharedState.final).toBe(15);
    for (const result of Object.values(snapshot.subflowResults ?? {}) as any[]) {
      expect(result.outputHandoff).toBeUndefined();
    }
  });

  it('a net no-op merge does not invent a new handoff writer', async () => {
    const chart = flowChart<State>('Start', () => {}, 'start')
      .addSubFlowChartNext('first', childWith(), 'First', {
        outputMapper: (out: State) => ({ renamed: out.localOutput }),
      })
      .addSubFlowChartNext('second', childWith(), 'Second', {
        outputMapper: (out: State) => ({ renamed: out.localOutput }),
      })
      .build();
    const { snapshot } = await run(chart);
    const second = required(snapshot.commitLog.find((bundle) => bundle.stageId === 'second'));
    expect(second.trace).toEqual([]);
    expect(resultFor(snapshot, second.runtimeStageId).outputHandoff).toBeUndefined();
    expect(snapshot.commitLog.filter((bundle) => bundle.trace.some((row) => row.path === 'renamed'))).toHaveLength(1);
  });

  it('privacy-active mapping withholds child read precision and retains no secret value', async () => {
    const secret = 'only-in-live-state-938';
    const child = flowChart<State>(
      'Secret',
      (scope) => {
        scope.localOutput = secret;
      },
      'secret',
    ).build();
    const chart = flowChart<State>('Parent start', () => {}, 'start')
      .addSubFlowChartNext('child', child, 'Child', {
        outputMapper: (output: State) => ({ renamed: output.localOutput }),
      })
      .build();
    const executor = new FlowChartExecutor(chart, captureOptions);
    executor.setRedactionPolicy({ keys: ['localOutput'] });
    await executor.run();
    const snapshot = executor.getSnapshot();
    const merge = required(snapshot.commitLog.find((bundle) => bundle.trace.some((row) => row.path === 'renamed')));
    const handoff = resultFor(snapshot, merge.runtimeStageId).outputHandoff;
    expect(handoff.status).toBe('partial');
    expect(handoff.limitations).toContain('privacy-active');
    expect(handoff.writes.every((write: { reads: string[] }) => write.reads.length === 0)).toBe(true);
    expect(JSON.stringify(handoff)).not.toContain(secret);
    expect(JSON.stringify(snapshot.commitLog)).not.toContain(secret);
    expect(snapshot.sharedState.renamed).toBe(secret);
  });

  it('an explicit returned value stays partial rather than pretending to be child state', async () => {
    const child = flowChart<State>('Return', () => ({ localOutput: 14 }), 'return').build();
    const { snapshot } = await run(chartWith(undefined, child));
    const merge = required(snapshot.commitLog.find((bundle) => bundle.trace.some((row) => row.path === 'renamed')));
    const handoff = resultFor(snapshot, merge.runtimeStageId).outputHandoff;
    expect(handoff.status).toBe('partial');
    expect(handoff.limitations).toContain('explicit-output');
    expect(handoff.writes.every((write: { reads: string[] }) => write.reads.length === 0)).toBe(true);
    expect(snapshot.sharedState.final).toBe(15);
  });
  it('several mapped outputs retain the conservative observed child read prefix', async () => {
    const { snapshot } = await run(chartWith((child) => ({ renamed: child.localOutput, other: child.localSource })));
    const merge = required(snapshot.commitLog.find((bundle) => bundle.trace.some((row) => row.path === 'renamed')));
    const handoff = resultFor(snapshot, merge.runtimeStageId).outputHandoff;
    expect(handoff.status).toBe('captured');
    expect(handoff.writes).toEqual([
      { path: 'renamed', reads: ['localOutput', 'localSource'] },
      { path: 'other', reads: ['localOutput', 'localSource'] },
    ]);
    expect(handoff.attribution).toBe('observed-read-prefix');
    expect(snapshot.sharedState).toEqual({ renamed: 14, other: 7, final: 15 });
  });

  it('a mutated child output view stays partial instead of claiming the original child writer', async () => {
    const { snapshot } = await run(
      chartWith((child) => {
        child.localOutput = 99;
        return { renamed: child.localOutput };
      }),
    );
    const merge = required(snapshot.commitLog.find((bundle) => bundle.trace.some((row) => row.path === 'renamed')));
    const handoff = resultFor(snapshot, merge.runtimeStageId).outputHandoff;
    expect(handoff.status).toBe('partial');
    expect(handoff.limitations).toContain('output-mutated');
    expect(handoff.writes.every((write: { reads: string[] }) => write.reads.length === 0)).toBe(true);
    expect(snapshot.sharedState.final).toBe(100);
  });

  it('child selection capture is bounded and discloses exhausted precision', async () => {
    const child = flowChart<State>(
      'Many child keys',
      (scope) => {
        for (let i = 0; i < 4_100; i++) scope[`key${i}`] = i;
      },
      'many',
    ).build();
    const { snapshot } = await run(chartWith((output) => ({ renamed: Object.values(output).length }), child));
    const merge = required(snapshot.commitLog.find((bundle) => bundle.trace.some((row) => row.path === 'renamed')));
    const handoff = resultFor(snapshot, merge.runtimeStageId).outputHandoff;
    expect(handoff.status).toBe('partial');
    expect(handoff.limitations).toContain('budget-exhausted');
    expect(handoff.writes).toHaveLength(1);
    expect(handoff.writes[0].reads.length).toBeLessThanOrEqual(4_096);
    expect(snapshot.sharedState.renamed).toBe(4_100);
  });
  it('a failed merge-back commit retains no successful output handoff', async () => {
    const executor = new FlowChartExecutor(
      chartWith((child) => ({ renamed: child.localOutput, uncloneable: () => 1 })),
      captureOptions,
    );
    await expect(executor.run()).rejects.toThrow();
    const snapshot = executor.getSnapshot();
    expect(snapshot.commitLog.some((bundle) => bundle.trace.some((row) => row.path === 'renamed'))).toBe(false);
    for (const result of Object.values(snapshot.subflowResults ?? {}) as any[]) {
      expect(result.outputHandoff).toBeUndefined();
    }
  });
  it('captures observed child selections independently of per-write provenance', async () => {
    const { snapshot } = await run(chartWith(), { writeProvenance: 'off' });
    handoffFor(snapshot);
    expect(snapshot.commitLog.every((bundle) => bundle.trace.every((row) => row.readKeys === undefined))).toBe(true);
    expect(snapshot.sharedState.final).toBe(15);
  });

  it('existing reads-prefix users keep capture disabled and unchanged commit bytes by default', async () => {
    const executor = new FlowChartExecutor(chartWith(), { writeProvenance: 'reads-prefix' });
    await executor.run();
    const defaultSnapshot = executor.getSnapshot();
    const disabled = (await run(chartWith(), { captureOutputHandoff: false })).snapshot;
    const enabled = (await run()).snapshot;
    expect(defaultSnapshot.commitLog).toEqual(disabled.commitLog);
    expect(defaultSnapshot.commitLog).toEqual(enabled.commitLog);
    for (const result of Object.values(defaultSnapshot.subflowResults ?? {}) as any[]) {
      expect(result.outputHandoff).toBeUndefined();
    }
  });

  it.each(['freeze', 'seal'] as const)(
    'preserves Object.%s and assignment rules for the output view',
    async (operation) => {
      const { snapshot } = await run(
        chartWith((child) => {
          if (operation === 'freeze') {
            Object.freeze(child);
            expect(Object.isFrozen(child)).toBe(true);
            expect(() => {
              child.localOutput = 99;
            }).toThrow(TypeError);
          } else {
            Object.seal(child);
            expect(Object.isSealed(child)).toBe(true);
            child.localOutput = 99;
          }
          expect(() => {
            child.newKey = 1;
          }).toThrow(TypeError);
          return { renamed: child.localOutput };
        }),
      );
      expect(snapshot.sharedState.renamed).toBe(operation === 'freeze' ? 14 : 99);
      const child = Object.values(snapshot.subflowResults ?? {}).find((result: any) => result.outputHandoff) as any;
      expect(child.treeContext.globalContext.localOutput).toBe(14);
    },
  );

  it('a held output view stays readable after mapping without adding later observations', async () => {
    let held: State | undefined;
    const { snapshot } = await run(
      chartWith((child) => {
        held = child;
        return { renamed: child.localOutput };
      }),
    );
    const { handoff } = handoffFor(snapshot);
    const retained = JSON.stringify(handoff);
    expect(required(held).localSource).toBe(7);
    expect(required(held).localOutput).toBe(14);
    expect(JSON.stringify(handoff)).toBe(retained);
    expect(handoff.writes[0].reads).toEqual(['localOutput']);
  });

  it('structuredClone of an ordinary copied output remains supported', async () => {
    const { snapshot } = await run(
      chartWith((child) => {
        const copy = structuredClone({ ...child });
        expect(copy).toEqual({ localSource: 7, localOutput: 14 });
        return { renamed: copy.localOutput };
      }),
    );
    handoffFor(snapshot, 'renamed', ['localSource', 'localOutput']);
    expect(snapshot.sharedState.final).toBe(15);
  });

  it('a class getter first reading child state at commit discloses incomplete attribution', async () => {
    class ReadAtCommit {
      constructor(child: State) {
        Object.defineProperty(this, 'n', { enumerable: true, get: () => child.localOutput });
      }
    }
    const { snapshot } = await run(chartWith((child) => ({ renamed: new ReadAtCommit(child) })));
    const merge = required(snapshot.commitLog.find((bundle) => bundle.trace.some((row) => row.path === 'renamed')));
    const handoff = resultFor(snapshot, merge.runtimeStageId).outputHandoff;
    expect(snapshot.sharedState.renamed).toEqual({ n: 14 });
    expect(handoff.status).toBe('partial');
    expect(handoff.limitations).toContain('commit-time-read');
    expect(handoff.writes).toEqual([{ path: 'renamed', reads: [] }]);
  });

  it('a scope commit observer cannot retroactively expand child selection capture', async () => {
    let held: State | undefined;
    const observed: unknown[] = [];
    const executor = new FlowChartExecutor(
      chartWith((child) => {
        held = child;
        return { renamed: child.localOutput };
      }),
      captureOptions,
    );
    executor.attachScopeRecorder({
      id: 'read-held-child-on-commit',
      onCommit: (event) => {
        // The mapper has no ScopeFacade of its own; Use is the first public
        // scope commit callback after its merge-back has landed.
        if (event.stageId === 'use' && event.mutations.some((mutation) => mutation.key === 'final')) {
          observed.push(required(held).localSource);
        }
      },
    });
    await executor.run();
    const { handoff } = handoffFor(executor.getSnapshot());
    expect(observed).toEqual([7]);
    expect(handoff.status).toBe('captured');
    expect(handoff.writes[0].reads).toEqual(['localOutput']);
    expect(handoff.limitations).toEqual([]);
  });
  it('a redacted snapshot withholds reference precision without changing the retained handoff', async () => {
    const { executor, snapshot } = await run();
    const { handoff, parentCommit } = handoffFor(snapshot);
    const redacted = executor.getSnapshot({ redact: true });
    const served = resultFor(redacted, parentCommit.runtimeStageId).outputHandoff;
    expect(served.status).toBe('partial');
    expect(served.limitations).toContain('privacy-active');
    expect(served.writes.every((write: { reads: string[] }) => write.reads.length === 0)).toBe(true);
    expect(handoff.status).toBe('captured');
    expect(handoff.writes[0].reads).toEqual(['localOutput']);
    expect(resultFor(executor.getSnapshot(), parentCommit.runtimeStageId).outputHandoff).toEqual(handoff);
  });
});
