/**
 * parallelForEach — one branch per item, decided at RUN time
 *
 * A normal fan-out names its branches when you write the chart. This one does
 * not know how many branches there will be until the data arrives: three
 * chunks make three branches, ten make ten.
 *
 * ## What each branch is
 *
 * Each branch runs as its own SUBFLOW — its own isolated memory, its own
 * commit log, addressable in every trace query at `<stageId>~<index>`. Which
 * means three things you get for free:
 *
 *   - branches cannot corrupt each other's in-flight state;
 *   - the item each branch got is IN its scope (and so in its trace), not
 *     hidden inside a closure;
 *   - `causalChain` / `sliceForKey` read branch commits with no special
 *     handling — the id shape is the shape they already speak.
 *
 * ## The two laws worth knowing before you use it
 *
 *   1. `into` gets ONE ordered array. `into[i]` is branch `i`'s result, in
 *      ITEMS order, no matter which branch finished first.
 *   2. `maxBranches` is REQUIRED and it is a real ceiling. Items past it do
 *      not run, and the truncation is recorded in the stage's log — an
 *      unbounded fan-out driven by upstream data is a resource attack, so
 *      there is no default to forget.
 *
 * Run: npx tsx examples/runtime-features/parallel-for-each/01-fan-out-per-item.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import { parseRuntimeStageId } from 'footprintjs/trace';

// ── State ───────────────────────────────────────────────────────────────────

interface ReviewState {
  document: string;
  chunks: string[];
  reviews: Array<{ index: number; words: number; flagged: boolean }>;
  summary: string;
  [key: string]: unknown;
}

interface ChunkState {
  /** Seeded by the engine — the item this branch was handed. */
  item: string;
  /** Seeded by the engine — this branch's position in the items array. */
  index: number;
  words: number;
  flagged: boolean;
  [key: string]: unknown;
}

// ── The per-item branch chart ───────────────────────────────────────────────
//
// Built fresh for each item. It can close over the item, read it from scope,
// or both — reading from scope is what puts it in the trace.

const reviewChunk = () =>
  flowChart<ChunkState>(
    'Count words',
    (scope) => {
      scope.words = scope.item.trim().split(/\s+/).filter(Boolean).length;
    },
    'count-words',
  )
    .addFunction(
      'Flag long chunks',
      (scope) => {
        scope.flagged = scope.words > 6;
      },
      'flag',
    )
    .build();

// ── The chart ───────────────────────────────────────────────────────────────

const chart = flowChart<ReviewState>(
  'Split into chunks',
  (scope) => {
    scope.document =
      'Footprint charts explain themselves. ' +
      'Every stage commits what it wrote and why it ran. ' +
      'A reviewer can replay the whole thing later.';
    scope.chunks = scope.document.split('. ').filter(Boolean);
  },
  'split',
)
  .addParallelForEach('Review each chunk', 'review-chunks', {
    // Reads here are tracked like any stage read — the fan-out's own input
    // shows up in the trace and in a backward slice.
    items: (scope) => scope.chunks,
    branch: () => reviewChunk(),
    maxBranches: 8,
    into: 'reviews',
  })
  .addFunction(
    'Summarize',
    (scope) => {
      const flagged = scope.reviews.filter((r) => r?.flagged).length;
      scope.summary = `${scope.reviews.length} chunks reviewed, ${flagged} flagged as long`;
    },
    'summarize',
  )
  .build();

// ── Run ─────────────────────────────────────────────────────────────────────

(async () => {
  const executor = new FlowChartExecutor(chart);
  await executor.run();
  const snapshot = executor.getSnapshot();
  const state = snapshot.sharedState as unknown as ReviewState;

  console.log('\n── Results (ITEMS order, always) ──');
  state.reviews.forEach((review, i) => {
    console.log(`  [${i}] ${review.words} words${review.flagged ? '  ← flagged' : ''}`);
  });
  console.log(`\n  ${state.summary}`);

  // ── Where the branches live in the trace ──
  //
  // Each branch is a subflow keyed by its generated path segment. Its commits
  // are in ITS OWN log (the shipped subflow-isolation law), and every id
  // parses with the ordinary grammar — nothing here knows about fan-outs.
  console.log('\n── Branch addresses in the trace ──');
  for (const [path, result] of Object.entries(snapshot.subflowResults ?? {})) {
    if (path.includes('#')) continue; // per-iteration duplicate keys
    const history = (result as { treeContext: { history: Array<{ runtimeStageId: string }> } }).treeContext.history;
    for (const bundle of history) {
      if (!bundle.runtimeStageId.includes('#')) continue; // the subflow's seed frame
      const { subflowPath, stageId, executionIndex } = parseRuntimeStageId(bundle.runtimeStageId);
      console.log(`  ${bundle.runtimeStageId}`.padEnd(40) + `→ branch '${subflowPath}', stage '${stageId}' #${executionIndex}`);
    }
  }

  // ── The parent's own commit: ONE ordered array write ──
  const fanOutCommit = snapshot.commitLog.find((b) => b.stageId === 'review-chunks');
  console.log('\n── The fan-out stage committed ──');
  console.log('  keys:', Object.keys(fanOutCommit?.overwrite ?? {}));
})();
