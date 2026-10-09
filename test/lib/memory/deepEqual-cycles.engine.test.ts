/** Engine witness: cyclic values survive subflow merge-back and every record reader. */
import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../src/lib/builder/FlowChartBuilder.js';
import { ArrayMergeMode } from '../../../src/lib/engine/types.js';
import type { CommitBundle } from '../../../src/lib/memory/types.js';
import { FlowChartExecutor } from '../../../src/lib/runner/FlowChartExecutor.js';
import { commitValueAt, stateAt, timeTravel } from '../../../src/trace.js';

interface Schema {
  name: string;
  version: number;
  params: Record<string, unknown>;
  self?: Schema;
}

/** The field shape: an object that references itself one key down. `version`
 *  is set AFTER `self` so a compare walks the cycle before it can find the
 *  one leaf that differs between two versions. */
function cyclicSchema(version = 1): Schema {
  const s = { name: 'search', params: { q: 'string' } } as Schema;
  s.self = s;
  s.version = version;
  return s;
}

// ════════════════════════════════════════════════════════════════════════
// (e) engine — a cyclic value crosses a subflow outputMapper; the run completes
// ════════════════════════════════════════════════════════════════════════

interface Inner {
  schema?: Schema;
}
interface Outer {
  tools?: Schema[];
  tool?: Schema;
  done?: boolean;
}

/** Outer seeds `tools = [v1]`, the subflow describes a schema, its outputMapper
 *  REPLACES `tools` — a `set` over a key that already holds a cyclic value, so
 *  the net-change filter must compare two cycles. */
function outputMapperChart(describe: () => Schema) {
  const inner = flowChart<Inner>(
    'Describe',
    async (scope) => {
      scope.schema = describe(); // TypedScope set trap: JSON round-trip fails, value passes through raw
    },
    'describe',
  ).build();

  return flowChart<Outer>(
    'Seed',
    async (scope) => {
      scope.tools = [cyclicSchema(1)];
    },
    'seed',
  )
    .addSubFlowChartNext('sf-tools', inner, 'Tools', {
      outputMapper: (s: Inner) => ({ tools: [s.schema] }),
      arrayMerge: ArrayMergeMode.Replace,
    })
    .addFunction(
      'Finish',
      async (scope) => {
        scope.done = true;
      },
      'finish',
    )
    .build();
}

function toolsWriters(log: readonly CommitBundle[]): CommitBundle[] {
  return log.filter((b) => b.trace.some((t) => t.path === 'tools'));
}

function outputMapperErrors(snapshot: { executionTree: unknown }): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const errors = (node as { errors?: Record<string, unknown> }).errors;
    if (errors && Object.prototype.hasOwnProperty.call(errors, 'outputMapperError')) {
      out.push(String(errors.outputMapperError));
    }
  };
  for (const node of Object.values(snapshot.executionTree as Record<string, unknown>)) walk(node);
  return out;
}

describe('engine — a cyclic value through a subflow outputMapper', () => {
  it('a changed cyclic twin commits, and the log, the fold and the cursor all hold the cycle', async () => {
    const executor = new FlowChartExecutor(outputMapperChart(() => cyclicSchema(2)));
    await executor.run();
    const snapshot = executor.getSnapshot();

    // The run completed and nothing was swallowed on the way.
    expect(outputMapperErrors(snapshot)).toEqual([]);
    expect(snapshot.sharedState.done).toBe(true);

    // Live state: the merged-back value is the v2 cycle.
    const live = snapshot.sharedState.tools as Schema[];
    expect(live[0].version).toBe(2);
    expect(live[0].self).toBe(live[0]);

    // The inner run held the cycle too — landmine 1 (the TypedScope JSON
    // round-trip) lets a cyclic value through untouched.
    const sf = (snapshot.subflowResults as Record<string, { treeContext: { globalContext: Inner } }>)['sf-tools'];
    expect(sf.treeContext.globalContext.schema?.self).toBe(sf.treeContext.globalContext.schema);

    // Commit log: seed (v1) and mount (v2) both wrote `tools`, both hold a cycle.
    const writers = toolsWriters(snapshot.commitLog);
    expect(writers).toHaveLength(2);
    for (const bundle of writers) {
      const tools = (bundle.overwrite as { tools: Schema[] }).tools;
      expect(tools[0].self).toBe(tools[0]);
    }
    expect((writers[1].overwrite as { tools: Schema[] }).tools[0].version).toBe(2);

    // The fold, the reconstructed value and every cursor stop terminate.
    const last = snapshot.commitLog.length - 1;
    const folded = stateAt(snapshot, last);
    const foldedTools = folded.state.tools as Schema[];
    expect(foldedTools[0].version).toBe(2);
    expect(foldedTools[0].self).toBe(foldedTools[0]);
    expect(Object.isFrozen(foldedTools[0])).toBe(true);

    const at = commitValueAt(snapshot.commitLog as CommitBundle[], last, 'tools') as Schema[];
    expect(at[0].version).toBe(2);
    expect(at[0].self).toBe(at[0]);

    const tt = timeTravel(snapshot);
    for (const stop of tt.stops) expect(() => tt.stateAt(stop)).not.toThrow();
  });

  it('an identical cyclic twin is a no-op write — nothing spurious is committed', async () => {
    const executor = new FlowChartExecutor(outputMapperChart(() => cyclicSchema(1)));
    await executor.run();
    const snapshot = executor.getSnapshot();

    expect(outputMapperErrors(snapshot)).toEqual([]);
    expect(snapshot.sharedState.done).toBe(true);
    expect(toolsWriters(snapshot.commitLog)).toHaveLength(1); // the seed only
  });

  it('the merge verb ($update) takes a cyclic value and every replay of it terminates', async () => {
    const chart = flowChart<Outer>(
      'Seed',
      async (scope) => {
        scope.tool = { name: 'old', version: 0, params: {} };
      },
      'seed',
    )
      .addFunction(
        'Update',
        async (scope) => {
          scope.$update('tool', cyclicSchema(3));
        },
        'update',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const snapshot = executor.getSnapshot();

    const live = snapshot.sharedState.tool as Schema;
    expect(live.version).toBe(3);
    expect(live.self).toBe(live);

    const last = snapshot.commitLog.length - 1;
    expect(snapshot.commitLog[last].trace.map((t) => t.verb)).toEqual(['merge']);
    const folded = stateAt(snapshot, last).state.tool as Schema;
    expect(folded.version).toBe(3);
    expect(folded.self).toBe(folded);
    const at = commitValueAt(snapshot.commitLog as CommitBundle[], last, 'tool') as Schema;
    expect(at.version).toBe(3);
    expect(at.self).toBe(at);
  });
});
