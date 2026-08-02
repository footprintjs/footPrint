/**
 * THE ZERO-CHANGES PROOF — branch commits read back through the shipped trace
 * queries with no modification to any of them.
 *
 * Design: docs/design/execution-control.md — Round B test 3. The doc's central
 * claim for D1 is that a generated branch is addressable by the SAME grammar a
 * hand-authored subflow uses, so `parseRuntimeStageId`, `causalChain`,
 * `sliceForKey` and `forwardSliceForKey` need no changes at all. That claim is
 * cheap to assert and worth proving, so this file proves it: every query below
 * runs against a real fan-out's real commit log, unmodified.
 *
 * Test types: Integration (real executor, real commit log, real queries) ·
 * Functional (each query answers correctly about a branch) · Unit (id shapes).
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import type { StageSnapshot } from '../../../src/lib/memory/types.js';
import {
  causalChain,
  forwardSliceForKey,
  keysReadFromExecutionTree,
  parseRuntimeStageId,
  sliceForKey,
  splitStageId,
} from '../../../src/trace.js';

interface ParentState {
  chunks?: string[];
  reviews?: unknown[];
  verdict?: string;
  [key: string]: unknown;
}

interface BranchState {
  item?: string;
  index?: number;
  cleaned?: string;
  score?: number;
  [key: string]: unknown;
}

/**
 * One fan-out over two chunks. Each branch has TWO stages so a branch has a
 * real internal causal edge to find: `clean` writes `cleaned`, `score` reads
 * it and writes `score`.
 */
function buildChart() {
  return flowChart<ParentState>(
    'Split',
    (scope) => {
      scope.chunks = ['alpha', 'beta'];
    },
    'split',
  )
    .addParallelForEach('Review each chunk', 'review-chunks', {
      items: (scope) => scope.chunks ?? [],
      branch: () =>
        flowChart<BranchState>(
          'Clean',
          (scope) => {
            scope.cleaned = String(scope.item).trim().toUpperCase();
          },
          'clean',
        )
          .addFunction(
            'Score',
            (scope) => {
              scope.score = String(scope.cleaned).length;
            },
            'score',
          )
          .build(),
      maxBranches: 4,
      into: 'reviews',
    })
    .addFunction(
      'Verdict',
      (scope) => {
        const reviews = (scope.reviews ?? []) as BranchState[];
        scope.verdict = reviews.map((r) => r.score).join(',');
      },
      'verdict',
    )
    .build();
}

async function runIt() {
  const executor = new FlowChartExecutor(buildChart(), { writeProvenance: 'reads-prefix' });
  await executor.run();
  return executor.getSnapshot();
}

describe('generated branches read back through the SHIPPED trace queries, unmodified', () => {
  /**
   * A branch is a subflow, so — exactly like a hand-authored subflow — its
   * commits live in its OWN isolated log, reachable at the generated segment
   * in `subflowResults` (the shipped isolation law, unchanged by this feature:
   * docs/design/subflow-commit-visibility.md).
   */
  function branchLogOf(snapshot: Awaited<ReturnType<typeof runIt>>, segment: string) {
    const branch = snapshot.subflowResults![segment] as {
      treeContext: { history: any[]; stageContexts: unknown };
    };
    return branch.treeContext.history;
  }

  /**
   * Stage commits only. A subflow seeded through an inputMapper also commits
   * on its ROOT frame (that is how `{ item, index }` becomes visible in the
   * branch's own log) and a root frame has no `stageId#index` — the shipped
   * shape for every seeded subflow, generated or hand-authored.
   */
  function stageCommitsOf(snapshot: Awaited<ReturnType<typeof runIt>>, segment: string) {
    return branchLogOf(snapshot, segment).filter((b: any) => b.runtimeStageId.includes('#'));
  }

  it('parseRuntimeStageId decomposes a branch stage exactly like a hand-authored subflow stage', async () => {
    const snapshot = await runIt();

    const branchCommits = [
      ...stageCommitsOf(snapshot, 'review-chunks~0'),
      ...stageCommitsOf(snapshot, 'review-chunks~1'),
    ];
    expect(branchCommits.length).toBeGreaterThan(0);

    const first = parseRuntimeStageId(branchCommits[0].runtimeStageId);
    expect(first.subflowPath).toBe('review-chunks~0');
    expect(['clean', 'score']).toContain(first.stageId);
    expect(Number.isInteger(first.executionIndex)).toBe(true);

    // Both branches are addressable, and their paths differ only by index.
    const paths = new Set(branchCommits.map((b) => parseRuntimeStageId(b.runtimeStageId).subflowPath));
    expect([...paths].sort()).toEqual(['review-chunks~0', 'review-chunks~1']);
  });

  it('splitStageId decomposes the prefixed commit stageId the same way', async () => {
    const snapshot = await runIt();
    const branchCommit = branchLogOf(snapshot, 'review-chunks~1').find((b: any) =>
      b.runtimeStageId.startsWith('review-chunks~1/score'),
    )!;

    expect(splitStageId(branchCommit.stageId)).toEqual({
      localStageId: 'score',
      subflowPath: 'review-chunks~1',
    });
  });

  it('every commit round-trips through the grammar (id → parts → id), branches included', async () => {
    const snapshot = await runIt();
    const everyCommit = [
      ...snapshot.commitLog,
      ...stageCommitsOf(snapshot, 'review-chunks~0'),
      ...stageCommitsOf(snapshot, 'review-chunks~1'),
    ];
    for (const bundle of everyCommit) {
      const { stageId, executionIndex, subflowPath } = parseRuntimeStageId(bundle.runtimeStageId);
      const rebuilt = `${subflowPath ? `${subflowPath}/` : ''}${stageId}#${executionIndex}`;
      expect(rebuilt).toBe(bundle.runtimeStageId);
    }
  });

  it('causalChain walks INSIDE a branch — score ← cleaned ← the seeded item', async () => {
    const executor = new FlowChartExecutor(buildChart(), { writeProvenance: 'reads-prefix' });
    await executor.run();
    // A branch runs in an isolated runtime, so its causal evidence lives in the
    // branch's OWN commit log — which the snapshot exposes per subflow path,
    // keyed by the generated segment. (Documented in slice/README.md: slicing
    // across a mount re-anchors on the subflow's own history.)
    const branch = executor.getSnapshot().subflowResults!['review-chunks~0'] as {
      treeContext: { history: unknown[]; stageContexts: unknown };
    };
    const branchLog = branch.treeContext.history as Parameters<typeof causalChain>[0];

    const scoreCommit = branchLog.find((b: any) => b.runtimeStageId.includes('score#'))! as any;
    const chain = causalChain(branchLog, scoreCommit.runtimeStageId, (id) => {
      const parsed = parseRuntimeStageId(id);
      return parsed.stageId === 'score' ? ['cleaned'] : parsed.stageId === 'clean' ? ['item'] : [];
    });

    expect(chain.runtimeStageId).toBe(scoreCommit.runtimeStageId);
    // score's parent is clean — an edge found with no knowledge of the marker.
    expect(chain.parents.map((p) => parseRuntimeStageId(p.runtimeStageId).stageId)).toContain('clean');
  });

  it('sliceForKey answers "why is this branch result what it is?" unmodified', async () => {
    const executor = new FlowChartExecutor(buildChart(), { writeProvenance: 'reads-prefix' });
    await executor.run();
    const snapshot = executor.getSnapshot();
    const branch = snapshot.subflowResults!['review-chunks~1'] as {
      treeContext: { history: unknown[]; stageContexts: Record<string, unknown> };
    };

    const slice = sliceForKey(
      branch.treeContext.history as never,
      'score',
      keysReadFromExecutionTree(branch.treeContext.stageContexts as unknown as StageSnapshot),
    );

    expect(slice.missing).toBeUndefined();
    expect(parseRuntimeStageId(slice.writer!.runtimeStageId).stageId).toBe('score');
    expect(parseRuntimeStageId(slice.writer!.runtimeStageId).subflowPath).toBe('review-chunks~1');
  });

  it('sliceForKey on the PARENT anchors the results array at the fan-out stage', async () => {
    const executor = new FlowChartExecutor(buildChart(), { writeProvenance: 'reads-prefix' });
    await executor.run();
    const snapshot = executor.getSnapshot();

    const slice = sliceForKey(
      snapshot.commitLog,
      'reviews',
      keysReadFromExecutionTree(snapshot.executionTree as StageSnapshot),
    );

    expect(slice.missing).toBeUndefined();
    // The fan-out stage is the writer of the ordered array — one write, one writer.
    expect(parseRuntimeStageId(slice.writer!.runtimeStageId).stageId).toBe('review-chunks');
  });

  it('forwardSliceForKey answers "what did the results feed?" — the merge stage', async () => {
    const executor = new FlowChartExecutor(buildChart(), { writeProvenance: 'reads-prefix' });
    await executor.run();
    const snapshot = executor.getSnapshot();

    const forward = forwardSliceForKey(
      snapshot.commitLog,
      'reviews',
      keysReadFromExecutionTree(snapshot.executionTree as StageSnapshot),
    );

    expect(forward.missing).toBeUndefined();
    const readers = forward.root!.reads.map((r) => parseRuntimeStageId(r.runtimeStageId).stageId);
    expect(readers).toContain('verdict');
  });

  it('the fan-out produces exactly ONE commit on the parent for the results array', async () => {
    const snapshot = await runIt();
    const fanOutCommits = snapshot.commitLog.filter(
      (b) => parseRuntimeStageId(b.runtimeStageId).stageId === 'review-chunks',
    );
    expect(fanOutCommits).toHaveLength(1);
    expect(Object.keys(fanOutCommits[0].overwrite ?? {})).toContain('reviews');
  });

  it("the branch's seeded item is IN its own commit log — provenance, not a hidden closure", async () => {
    const snapshot = await runIt();
    const seedCommit = branchLogOf(snapshot, 'review-chunks~0').find((b: any) => !b.runtimeStageId.includes('#'))!;
    expect(seedCommit.overwrite?.item).toBe('alpha');
    expect(seedCommit.overwrite?.index).toBe(0);
  });

  it('the run reaches the right answer end-to-end', async () => {
    const snapshot = await runIt();
    expect(snapshot.sharedState.verdict).toBe('5,4'); // ALPHA(5), BETA(4)
  });
});
