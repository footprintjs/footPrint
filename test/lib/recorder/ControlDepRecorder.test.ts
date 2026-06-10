/**
 * RFC-003 D5 — ControlDepRecorder fixtures.
 *
 * The required correlation fixtures from the spec:
 *   1. decider — chosen branch maps to the decider execution step
 *   2. selector — every selected branch maps to the selector step
 *   3. NESTED subflow branches — stages INSIDE a subflow branch resolve to
 *      the decision through the mount (D1 chains cross boundaries)
 *   4. loop re-entry — each iteration's stages map to THAT iteration's
 *      decision (runtime ids, not stage ids)
 *
 * Plus: decide() rule labels, nearest-decision nesting, convergence stages
 * NOT misattributed, error-consumed slots, Convention-4 runId reset, and
 * end-to-end integration with causalChain({ controlDeps }).
 */

import { describe, expect, it } from 'vitest';

import { decide, flowChart, FlowChartExecutor } from '../../../src/index.js';
import { causalChain, formatCausalChain } from '../../../src/lib/memory/backtrack.js';
import type { CommitBundle } from '../../../src/lib/memory/types.js';
import { controlDepRecorder } from '../../../src/lib/recorder/ControlDepRecorder.js';

type Loose = Record<string, unknown>;

/** Collect keysRead per step from onRead events (the standard pattern). */
function keysReadCollector() {
  const reads = new Map<string, string[]>();
  const recorder = {
    id: 'keys-read',
    onRead: (e: { runtimeStageId: string; key?: string }) => {
      if (!e.key) return;
      const arr = reads.get(e.runtimeStageId) ?? [];
      arr.push(e.key);
      reads.set(e.runtimeStageId, arr);
    },
  };
  return { recorder, getKeysRead: (id: string) => reads.get(id) ?? [] };
}

describe('ControlDepRecorder — decider fixture', () => {
  it('maps the chosen branch (and its descendants) to the decider step', async () => {
    const chart = flowChart<Loose>('Seed', async (s) => s.$setValue('score', 720), 'seed')
      .addDeciderFunction('Route', async (s) => ((s.$getValue('score') as number) > 700 ? 'high' : 'low'), 'route')
      .addFunctionBranch('high', 'High', async (s: Loose & { $setValue(k: string, v: unknown): void }) => {
        s.$setValue('status', 'approved');
      })
      .addFunctionBranch('low', 'Low', async () => undefined)
      .setDefault('low')
      .end()
      .build();

    const ctrl = controlDepRecorder();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(ctrl);
    await executor.run();

    // The branch root resolves to the decider execution step
    expect(ctrl.lookup('high#2')).toEqual({ deciderId: 'route#1' });
    // Stages BEFORE the decision are not governed by it
    expect(ctrl.lookup('seed#0')).toBeUndefined();
    // The decider itself is not governed by its own decision
    expect(ctrl.lookup('route#1')).toBeUndefined();
    // The non-chosen branch never ran — unknown id resolves to nothing
    expect(ctrl.lookup('low#99')).toBeUndefined();
  });

  it('captures decide() evidence and the matched rule label', async () => {
    const chart = flowChart<Loose>('Seed', async (s) => s.$setValue('creditScore', 750), 'seed')
      .addDeciderFunction(
        'ClassifyRisk',
        async (s) =>
          decide(
            s as never,
            [{ when: { creditScore: { gt: 700 } }, then: 'approved', label: 'Good credit' }],
            'rejected',
          ),
        'classify',
      )
      .addFunctionBranch('approved', 'Approve', async () => undefined)
      .addFunctionBranch('rejected', 'Reject', async () => undefined)
      .setDefault('rejected')
      .end()
      .build();

    const ctrl = controlDepRecorder();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(ctrl);
    await executor.run();

    const [record] = ctrl.getDecisions();
    expect(record.deciderRuntimeStageId).toBe('classify#1');
    expect(record.ruleLabel).toBe('Good credit');
    expect(record.evidence).toBeDefined();

    // The lookup carries the label through to the backtracker contract
    expect(ctrl.lookup('approved#2')).toEqual({ deciderId: 'classify#1', label: 'Good credit' });
  });
});

describe('ControlDepRecorder — selector fixture', () => {
  it('maps EVERY selected branch to the selector step; convergence is NOT misattributed', async () => {
    const chart = flowChart<Loose>('Seed', async () => undefined, 'seed')
      .addSelectorFunction('Pick', async () => ['x', 'y'], 'pick')
      .addFunctionBranch('x', 'X', async (s: Loose & { $setValue(k: string, v: unknown): void }) => {
        s.$setValue('a', 1);
      })
      .addFunctionBranch('y', 'Y', async (s: Loose & { $setValue(k: string, v: unknown): void }) => {
        s.$setValue('b', 2);
      })
      .addFunctionBranch('z', 'Z', async () => undefined)
      .end()
      .addFunction('Join', async () => undefined, 'join')
      .build();

    const ctrl = controlDepRecorder();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(ctrl);
    await executor.run();

    expect(ctrl.lookup('x#2')).toEqual({ deciderId: 'pick#1' });
    expect(ctrl.lookup('y#3')).toEqual({ deciderId: 'pick#1' });
    // Join chains to the selector context too — but both selected slots
    // were consumed, so it must NOT resolve as a branch entry.
    expect(ctrl.lookup('join#4')).toBeUndefined();

    const [record] = ctrl.getDecisions();
    expect(record.chosen).toEqual(['X', 'Y']);
  });

  it('a throwing selected branch consumes its slot (best-effort fan-out stays honest)', async () => {
    const chart = flowChart<Loose>('Seed', async () => undefined, 'seed')
      .addSelectorFunction('Pick', async () => ['ok', 'boom'], 'pick')
      .addFunctionBranch('ok', 'Ok', async (s: Loose & { $setValue(k: string, v: unknown): void }) => {
        s.$setValue('a', 1);
      })
      .addFunctionBranch('boom', 'Boom', async () => {
        throw new Error('branch failure');
      })
      .end()
      .addFunction('Join', async () => undefined, 'join')
      .build();

    const ctrl = controlDepRecorder();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(ctrl);
    await executor.run(); // best-effort: run resolves, Join executes

    // The failed branch RAN because of the decision — still attributed.
    const seen = [ctrl.lookup('ok#2'), ctrl.lookup('boom#3')];
    expect(seen.filter((d) => d?.deciderId === 'pick#1').length).toBe(2);
    // Convergence must not absorb the failed branch's slot.
    const joinDep = ctrl.lookup('join#4');
    expect(joinDep).toBeUndefined();
  });
});

describe('ControlDepRecorder — nested subflow branch fixture', () => {
  it('stages INSIDE a subflow branch resolve to the decision through the mount', async () => {
    const inner = flowChart<Loose>('InnerWork', async (s) => s.$setValue('w', 1), 'inner-work')
      .addFunction('InnerSecond', async (s) => s.$setValue('w2', 2), 'inner-second')
      .build();

    const chart = flowChart<Loose>('Seed', async () => undefined, 'seed')
      .addDeciderFunction('Route', async () => 'sf', 'route')
      .addSubFlowChartBranch('sf', inner, 'EscalateMount', {
        inputMapper: () => ({}),
        outputMapper: () => ({}),
      })
      .addFunctionBranch('plain', 'Plain', async () => undefined)
      .setDefault('plain')
      .end()
      .build();

    const ctrl = controlDepRecorder();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(ctrl);
    await executor.run();

    // Mount is the branch entry...
    expect(ctrl.lookup('sf#2')).toEqual({ deciderId: 'route#1' });
    // ...and BOTH inner stages resolve through it (D1 crosses the boundary)
    expect(ctrl.lookup('sf/inner-work#3')).toEqual({ deciderId: 'route#1' });
    expect(ctrl.lookup('sf/inner-second#4')).toEqual({ deciderId: 'route#1' });
  });

  it('doubly-nested subflows still resolve to the outer decision', async () => {
    const innermost = flowChart<Loose>('Deep', async (s) => s.$setValue('d', 1), 'deep').build();
    const middle = flowChart<Loose>('Mid', async (s) => s.$setValue('m', 1), 'mid')
      .addSubFlowChartNext('sf-deep', innermost, 'DeepMount', {
        inputMapper: () => ({}),
        outputMapper: () => ({}),
      })
      .build();

    const chart = flowChart<Loose>('Seed', async () => undefined, 'seed')
      .addDeciderFunction('Route', async () => 'sf-mid', 'route')
      .addSubFlowChartBranch('sf-mid', middle, 'MidMount', {
        inputMapper: () => ({}),
        outputMapper: () => ({}),
      })
      .addFunctionBranch('plain', 'Plain', async () => undefined)
      .setDefault('plain')
      .end()
      .build();

    const ctrl = controlDepRecorder();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(ctrl);
    await executor.run();

    // The deepest stage walks: deep → deep-mount → mid-root → outer mount → decision
    expect(ctrl.lookup('sf-mid/sf-deep/deep#5')?.deciderId).toBe('route#1');
  });
});

describe('ControlDepRecorder — loop re-entry fixture', () => {
  it("each iteration's branch maps to THAT iteration's decision (runtime ids)", async () => {
    const chart = flowChart<Loose>('Seed', async (s) => s.$setValue('i', 0), 'seed')
      .addFunction(
        'Work',
        async (s) => {
          s.$setValue('i', (s.$getValue('i') as number) + 1);
        },
        'work',
      )
      .addDeciderFunction('Check', async (s) => ((s.$getValue('i') as number) < 3 ? 'again' : 'done'), 'check')
      .addFunctionBranch('again', 'Again', async () => undefined, undefined, { loopTo: 'work' })
      .addFunctionBranch('done', 'Done', async () => undefined)
      .setDefault('done')
      .end()
      .build();

    const ctrl = controlDepRecorder();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(ctrl);
    await executor.run();

    const decisions = ctrl.getDecisions();
    expect(decisions.length).toBe(3); // again, again, done — three decisions
    const [d1, d2, d3] = decisions.map((d) => d.deciderRuntimeStageId);
    expect(new Set([d1, d2, d3]).size).toBe(3); // unique per iteration

    // Iteration 1: check#2 chose Again (again#3) → loops to work#4
    expect(ctrl.lookup('again#3')).toEqual({ deciderId: d1 });
    // The re-executed Work runs BECAUSE decision 1 chose to loop
    expect(ctrl.lookup('work#4')?.deciderId).toBe(d1);
    // Iteration 2's branch maps to decision 2, not decision 1
    expect(ctrl.lookup('again#6')).toEqual({ deciderId: d2 });
    expect(ctrl.lookup('work#7')?.deciderId).toBe(d2);
    // The terminating branch maps to the LAST decision
    expect(ctrl.lookup('done#9')).toEqual({ deciderId: d3 });
  });
});

describe('ControlDepRecorder — nesting resolves to the NEAREST decision', () => {
  it('decider inside a subflow branch: inner branch → inner decision; inner decider → outer decision', async () => {
    // The outer decider routes into a subflow whose chart contains its own
    // decider — the realistic nested-decision shape.
    const inner = flowChart<Loose>('InnerSeed', async () => undefined, 'inner-seed')
      .addDeciderFunction('InnerRoute', async () => 'leaf', 'inner-route')
      .addFunctionBranch('leaf', 'Leaf', async (s: Loose & { $setValue(k: string, v: unknown): void }) => {
        s.$setValue('leafDone', true);
      })
      .setDefault('leaf')
      .end()
      .build();

    const chart = flowChart<Loose>('Seed', async () => undefined, 'seed')
      .addDeciderFunction('Outer', async () => 'sf', 'outer')
      .addSubFlowChartBranch('sf', inner, 'GoMount', {
        inputMapper: () => ({}),
        outputMapper: () => ({}),
      })
      .addFunctionBranch('plain', 'Plain', async () => undefined)
      .setDefault('plain')
      .end()
      .build();

    const ctrl = controlDepRecorder();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(ctrl);
    await executor.run();

    const decisions = ctrl.getDecisions();
    expect(decisions.length).toBe(2);
    const outerId = decisions[0].deciderRuntimeStageId;
    const innerId = decisions[1].deciderRuntimeStageId;

    // The inner branch resolves to the INNER decision (nearest)...
    expect(ctrl.lookup('sf/leaf#5')?.deciderId).toBe(innerId);
    // ...while the inner decider itself is governed by the outer decision
    // (its chain crosses the mount back to the outer chosen branch).
    expect(ctrl.lookup(innerId)?.deciderId).toBe(outerId);
  });
});

describe('ControlDepRecorder — Convention 4 (runId reset)', () => {
  it('a second run starts clean: stale branch entries do not leak', async () => {
    // The decider flips branches between runs — run 1 takes A, run 2 takes B.
    // runtimeStageIds repeat across runs (the counter is per-run), so the
    // reset is observable through which branch entry resolves.
    let runNumber = 0;
    const chart = flowChart<Loose>('Seed', async () => undefined, 'seed')
      .addDeciderFunction('Route', async () => (runNumber === 1 ? 'a' : 'b'), 'route')
      .addFunctionBranch('a', 'A', async () => undefined)
      .addFunctionBranch('b', 'B', async () => undefined)
      .setDefault('a')
      .end()
      .build();

    const ctrl = controlDepRecorder();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(ctrl);

    runNumber = 1;
    await executor.run();
    expect(ctrl.getDecisions().length).toBe(1);
    expect(ctrl.getDecisions()[0].chosen).toBe('A');
    expect(ctrl.lookup('a#2')?.deciderId).toBe('route#1');
    expect(ctrl.lookup('b#2')).toBeUndefined();

    runNumber = 2;
    await executor.run();
    // Fresh run, fresh state — only run 2's branch entry resolves now.
    expect(ctrl.getDecisions().length).toBe(1);
    expect(ctrl.getDecisions()[0].chosen).toBe('B');
    expect(ctrl.lookup('b#2')?.deciderId).toBe('route#1');
    expect(ctrl.lookup('a#2')).toBeUndefined(); // run 1's entry is GONE
  });
});

describe('ControlDepRecorder — end-to-end with causalChain (the D3+D5 contract)', () => {
  it('status ← [control: Good credit] ClassifyRisk ← via creditScore PullBureau', async () => {
    const chart = flowChart<Loose>(
      'PullBureau',
      async (s) => {
        s.$setValue('creditScore', 750);
      },
      'pull-bureau',
    )
      .addDeciderFunction(
        'ClassifyRisk',
        async (s) =>
          decide(
            s as never,
            [{ when: { creditScore: { gt: 700 } }, then: 'approved', label: 'Good credit' }],
            'rejected',
          ),
        'classify',
      )
      .addFunctionBranch('approved', 'Approve', async (s: Loose & { $setValue(k: string, v: unknown): void }) => {
        s.$setValue('status', 'approved');
      })
      .addFunctionBranch('rejected', 'Reject', async () => undefined)
      .setDefault('rejected')
      .end()
      .build();

    const ctrl = controlDepRecorder();
    const { recorder: reads, getKeysRead } = keysReadCollector();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(ctrl);
    executor.attachScopeRecorder(reads);
    await executor.run();

    const log = executor.getSnapshot().commitLog as CommitBundle[];
    const statusCommit = log.find((b) => b.trace.some((t) => t.path === 'status'))!;

    const dag = causalChain(log, statusCommit.runtimeStageId, getKeysRead, {
      controlDeps: ctrl.asLookup(),
    })!;

    // Approve → [control] ClassifyRisk → [data: creditScore] PullBureau
    const classify = dag.parentEdges.find((e) => e.kind === 'control')!.parent;
    expect(classify.stageId).toBe('classify');
    const pull = classify.parentEdges.find((e) => e.kind === 'data' && e.key === 'creditScore')!.parent;
    expect(pull.stageId).toBe('pull-bureau');

    const text = formatCausalChain(dag);
    expect(text).toContain('← [control: Good credit]');
    expect(text).toContain('← via creditScore');
  });
});
