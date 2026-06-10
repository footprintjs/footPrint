/**
 * commitValues — the LOSSLESS encoding dial for the commit log (#13c-B)
 *
 * The commit log records the full final value of every changed path. For a
 * growing tracked array (an agent's `history` — one message appended per
 * iteration) that retains N(N+1)/2 messages: the last O(N²) retained-heap
 * term in long-running loops. `commitValues: 'delta'` fixes it LOSSLESSLY:
 *
 *   'full'  — default. Every surviving `set` stores the full final value.
 *             Byte-identical to the historical behavior.
 *   'delta' — when a stage's net change to an array is "the old array plus
 *             a tail", the bundle records ONLY the tail under an `append`
 *             trace verb; `deleteValue()` commits a real `delete` verb; one
 *             trace entry per surviving path. Replay reconstructs every
 *             step's full state exactly — nothing summarized, nothing
 *             dropped (unlike the readTracking/writeTracking dials, which
 *             gate lossy snapshot bookkeeping).
 *
 * The one consumer-visible change: `bundle.overwrite[key]` is now
 * verb-qualified — an append bundle holds only the tail. When you mean "the
 * full value at this commit", use `commitValueAt(commitLog, idx, key)` from
 * footprintjs/trace (shown below). Path-tier consumers (findLastWriter,
 * causalChain, narrative, lens highlights) are unaffected.
 *
 * Honest cost note: append detection is new wall work — an O(|base array|)
 * structural prefix compare per array-set path per commit. On a hit the
 * commit gets cheaper in both wall and heap; on a miss it pays compare +
 * full clone. 'full' pays zero.
 *
 * Run: npx tsx examples/runtime-features/commit-values/01-delta.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import { commitValueAt, findLastWriter } from 'footprintjs/trace';

interface AgentState {
  i: number;
  history: { idx: number; text: string }[];
}

const ITERATIONS = 8;

// An agent-style loop: every iteration appends one ~1KB message to `history`.
const buildChart = () =>
  flowChart<AgentState>(
    'Seed',
    async (scope) => {
      scope.i = 0;
      scope.history = [];
    },
    'seed',
  )
    .addFunction(
      'Work',
      async (scope) => {
        const i = scope.i;
        scope.$batchArray('history', (arr) => {
          arr.push({ idx: i, text: `message-${i}: ${'x'.repeat(1024)}` });
        });
        scope.i = i + 1;
        if (i + 1 >= ITERATIONS) scope.$break();
      },
      'work',
    )
    .loopTo('work')
    .build();

const bundleBytes = (b: { overwrite: unknown; updates: unknown }) =>
  (JSON.stringify(b.overwrite) ?? '').length + (JSON.stringify(b.updates) ?? '').length;

(async () => {
  // ── Run the SAME chart in both modes ───────────────────────────────────
  const snapshots = {} as Record<'full' | 'delta', ReturnType<FlowChartExecutor['getSnapshot']>>;
  for (const mode of ['full', 'delta'] as const) {
    const executor = new FlowChartExecutor(buildChart(), { commitValues: mode });
    await executor.run({ maxIterations: ITERATIONS + 10 });
    snapshots[mode] = executor.getSnapshot();
  }

  // ── 1. Per-bundle payload sizes: linear tails vs quadratic full arrays ──
  console.log(`commitValues: per-commit payload bytes over a ${ITERATIONS}-iteration growing-history loop\n`);
  console.log('  idx  stage   full-mode bytes   delta-mode bytes   delta verb');
  for (let i = 0; i < snapshots.full.commitLog.length; i++) {
    const f = snapshots.full.commitLog[i];
    const d = snapshots.delta.commitLog[i];
    if (!f.trace.some((t) => t.path === 'history')) continue;
    const verb = d.trace.find((t) => t.path === 'history')?.verb;
    console.log(
      `  ${String(i).padStart(3)}  ${f.stageId.padEnd(6)} ${String(bundleBytes(f)).padStart(15)} ${String(
        bundleBytes(d),
      ).padStart(18)}   ${verb}`,
    );
  }
  const total = (log: { overwrite: unknown; updates: unknown }[]) => log.reduce((s, b) => s + bundleBytes(b), 0);
  console.log(
    `\n  TOTAL commit-log value bytes — full: ${total(snapshots.full.commitLog)}, delta: ${total(
      snapshots.delta.commitLog,
    )} (the quadratic term is gone; grows ~linearly with iterations)\n`,
  );

  // ── 2. The snapshot discriminant ─────────────────────────────────────────
  console.log(`  snapshot.commitValues — full run: '${snapshots.full.commitValues}', delta run: '${snapshots.delta.commitValues}'\n`);

  // ── 3. commitValueAt — the full-value read under either encoding ────────
  const deltaLog = snapshots.delta.commitLog;
  const lastWriter = findLastWriter(deltaLog, 'history')!;
  const lastIdx = lastWriter.idx!;
  console.log(`  findLastWriter('history') → ${lastWriter.runtimeStageId} (verb-qualified overwrite holds ONLY the tail):`);
  console.log(`    bundle.overwrite.history.length = ${(lastWriter.overwrite.history as unknown[]).length} (the tail)`);
  const reconstructed = commitValueAt(deltaLog, lastIdx, 'history') as unknown[];
  console.log(`    commitValueAt(log, ${lastIdx}, 'history').length = ${reconstructed.length} (the FULL value)\n`);

  // ── 4. The lossless invariant, verified end-to-end ───────────────────────
  const sameFinalState = JSON.stringify(snapshots.delta.sharedState) === JSON.stringify(snapshots.full.sharedState);
  let everyStepReconstructs = true;
  for (let i = 0; i < deltaLog.length; i++) {
    const fullValue = commitValueAt(snapshots.full.commitLog, i, 'history');
    const deltaValue = commitValueAt(deltaLog, i, 'history');
    if (JSON.stringify(fullValue) !== JSON.stringify(deltaValue)) everyStepReconstructs = false;
  }
  console.log(`  lossless check — final sharedState identical across modes: ${sameFinalState}`);
  console.log(`  lossless check — history reconstructable at EVERY commit index: ${everyStepReconstructs}`);
  if (!sameFinalState || !everyStepReconstructs) {
    throw new Error('lossless invariant violated — delta mode must reconstruct exactly');
  }
})();
