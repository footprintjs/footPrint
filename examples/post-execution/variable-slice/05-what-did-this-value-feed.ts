/**
 * Forward Slice — "who READ this value, and what did it FEED?"
 *
 * The mirror of 01. That example asks why a value is what it is (backward,
 * from the value to its causes). This one runs the other way: pick a value,
 * see every stage that read it while it was live, and every write those
 * reads fed — the blast radius of one variable, in one query.
 *
 * The two halves of the answer:
 *   forwardSliceForKey  → the graph ("recipeId fed ingredients fed list")
 *   keyTimeline         → the flat story ("written @0, read @1, rewritten @3")
 *
 * A value's life ends at the key's NEXT write, so a rewritten key has
 * several lives and a read belongs to exactly one of them.
 *
 * HONESTY (the part worth reading): a `fed` edge is EXACT only when the
 * commit log recorded per-write read provenance — the `writeProvenance:
 * 'reads-prefix'` dial. Without it, all the log knows is "this stage read
 * that key and wrote this one", so every edge is stamped CONSERVATIVE and
 * the slice says so. This example runs the SAME chart both ways so you can
 * see the difference.
 *
 * Run: npx tsx examples/post-execution/variable-slice/05-what-did-this-value-feed.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import {
  formatForwardSlice,
  formatTimeline,
  forwardSliceForKey,
  forwardSliceToJSON,
  keysReadFromExecutionTree,
  keyTimeline,
} from 'footprintjs/trace';

interface State {
  recipeId: string;
  servings: number;
  ingredients?: string[];
  shoppingList?: string[];
  receipt?: string;
}

const chart = flowChart<State>('Seed', async (scope) => {
  scope.recipeId = 'r-42';
  scope.servings = 2;
}, 'seed')
  .addFunction('Lookup', async (scope) => {
    scope.ingredients = [`flour(${scope.recipeId})`, 'water'];
  }, 'lookup')
  .addFunction('Scale', async (scope) => {
    scope.shoppingList = scope.ingredients!.map((i) => `${i} x${scope.servings}`);
  }, 'scale')
  .addFunction('Swap', async (scope) => {
    scope.recipeId = 'r-99'; // a SECOND life of recipeId starts here
  }, 'swap')
  .addFunction('Receipt', async (scope) => {
    scope.receipt = `ordered for ${scope.recipeId}`;
  }, 'receipt')
  .build();

async function run(writeProvenance?: 'reads-prefix') {
  const executor = new FlowChartExecutor(chart, writeProvenance ? { writeProvenance } : {});
  await executor.run();
  return executor.getSnapshot();
}

(async () => {
  // ── 1. Exact edges: the writeProvenance dial ON ───────────────────────
  const exact = await run('reads-prefix');
  const reads = keysReadFromExecutionTree(exact.executionTree);

  console.log("who read 'recipeId', and what did it feed?\n");
  console.log(formatForwardSlice(forwardSliceForKey(exact.commitLog, 'recipeId', reads)));
  // FORWARD SLICE for 'recipeId' — reads via: execution-tree
  // 'recipeId' set by Swap (swap#3) @3 — live to the end of the run
  //   read by Receipt (receipt#4) @4
  //   → fed [exact] 'receipt' set by Receipt (receipt#4) @4 — live to the end of the run

  // The ANCHOR is the last write, exactly like sliceForKey. To follow the
  // FIRST life instead, anchor before the rewrite — `before` bounds the
  // anchor search only; the walk still runs forward from there.
  console.log('\n— the first life of recipeId (before the swap at commit 3):\n');
  const firstLife = forwardSliceForKey(exact.commitLog, 'recipeId', reads, { before: 3 });
  console.log(formatForwardSlice(firstLife));
  // 'recipeId' set by Seed (seed#0) @0 — live until commit 3
  //   read by Lookup (lookup#1) @1
  //   → fed [exact] 'ingredients' … → fed [exact] 'shoppingList' …

  // ── 2. The flat story of one key ──────────────────────────────────────
  console.log('\n— the whole life of recipeId:\n');
  console.log(formatTimeline(keyTimeline(exact.commitLog, 'recipeId', reads)));
  // @0 write set — Seed (seed#0)
  // @1 read  — Lookup (lookup#1) (value from commit 0)
  // @3 write set — Swap (swap#3)
  // @4 read  — Receipt (receipt#4) (value from commit 3)

  // ── 3. For a UI or a wire: the flat, id-referenced projection ─────────
  // NEVER JSON.stringify a slice root — the forward DAG shares nodes.
  const json = forwardSliceToJSON(firstLife);
  console.log('\n— as JSON:', JSON.stringify({ nodes: json.nodes?.length, edges: json.edges }));

  // ── 4. The same question with the dial OFF ────────────────────────────
  const conservative = await run();
  const slice = forwardSliceForKey(
    conservative.commitLog,
    'recipeId',
    keysReadFromExecutionTree(conservative.executionTree),
    { before: 3 },
  );
  console.log('\n— dial OFF: the same walk, honestly labeled:\n');
  console.log(formatForwardSlice(slice));
  // Every edge now reads [conservative], and the slice carries
  // ⚠ some 'fed' edges are CONSERVATIVE (stage-level) …
  console.log('\nnotes:', slice.notes.map((n) => n.code).join(', '));

  // ── 5. A typo is NAMED, never answered with a shrug ───────────────────
  const typo = forwardSliceForKey(exact.commitLog, 'recipId', reads);
  console.log('\n— a typo:\n');
  console.log(formatForwardSlice(typo));
  // no forward slice: 'recipId' was never written and never read in this log.
  // ⚠ unknown key 'recipId' — … Known keys: ingredients, receipt, recipeId, …
})().catch(console.error);
