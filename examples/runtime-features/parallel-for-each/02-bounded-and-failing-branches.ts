/**
 * parallelForEach — the ceiling, and what a failing branch does
 *
 * Two things every fan-out over untrusted data has to answer, and this example
 * shows both answers side by side.
 *
 * ## 1. How many branches can this start?
 *
 * `maxBranches` is REQUIRED. If the items come from a model, an upstream API,
 * or a user upload, "as many as the data says" is a resource attack — so the
 * ceiling is not optional and there is no default to forget. Past the ceiling
 * the extra items DO NOT RUN, and the truncation is written into the stage's
 * own log: bounded execution, stated, never silent.
 *
 * ## 2. What happens when one branch throws?
 *
 * The same policy the rest of the library's parallelism uses:
 *
 *   - DEFAULT (best-effort): every branch runs; the failed branch's SLOT in
 *     the results array is `undefined`, so the array still lines up with your
 *     items one-for-one.
 *   - `failFast: true`: the first failing branch rejects the whole stage.
 *
 * Run: npx tsx examples/runtime-features/parallel-for-each/02-bounded-and-failing-branches.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';

interface State {
  urls: string[];
  fetched: Array<{ url?: string; bytes?: number } | undefined>;
  [key: string]: unknown;
}

interface FetchState {
  item: string;
  index: number;
  url?: string;
  bytes?: number;
  [key: string]: unknown;
}

/** A "fetch" that fails for one known-bad host. */
const fetchOne = () =>
  flowChart<FetchState>(
    'Fetch',
    (scope) => {
      if (scope.item.includes('bad-host')) throw new Error(`connection refused: ${scope.item}`);
      scope.url = scope.item;
      scope.bytes = scope.item.length * 100;
    },
    'fetch',
  ).build();

function buildChart(opts: { maxBranches: number; failFast?: boolean }) {
  return flowChart<State>(
    'Collect URLs',
    (scope) => {
      // Pretend these arrived from a model's tool call — untrusted length.
      scope.urls = [
        'https://a.example/one',
        'https://bad-host.example/two',
        'https://c.example/three',
        'https://d.example/four',
        'https://e.example/five',
      ];
    },
    'collect',
  )
    .addParallelForEach('Fetch each URL', 'fetch-urls', {
      items: (scope) => scope.urls,
      branch: () => fetchOne(),
      maxBranches: opts.maxBranches,
      into: 'fetched',
      ...(opts.failFast !== undefined && { failFast: opts.failFast }),
    })
    .build();
}

(async () => {
  // ── Run 1: best-effort, ceiling of 3 ──────────────────────────────────────
  console.log('\n── Run 1: best-effort, maxBranches: 3 ──');
  const bestEffort = new FlowChartExecutor(buildChart({ maxBranches: 3 }));
  await bestEffort.run();
  const state = bestEffort.getSnapshot().sharedState as unknown as State;

  console.log('  5 urls, ceiling 3 → branches started:', state.fetched.length);
  state.fetched.forEach((entry, i) => {
    console.log(`   [${i}] ${entry ? `${entry.bytes} bytes` : 'FAILED (slot kept, so the array still lines up)'}`);
  });

  // The truncation is on the record, in the fan-out stage's own log.
  const tree = JSON.stringify(bestEffort.getSnapshot().executionTree);
  const stated = tree.match(/maxBranches reached: [^"]+/)?.[0];
  console.log('  stated in the trace:', stated);

  // ── Run 2: failFast ───────────────────────────────────────────────────────
  console.log('\n── Run 2: failFast: true ──');
  try {
    await new FlowChartExecutor(buildChart({ maxBranches: 3, failFast: true })).run();
    console.log('  (unreachable — the bad host rejects)');
  } catch (error) {
    console.log('  rejected with:', (error as Error).message);
    console.log('  → use failFast when EVERY branch is required.');
  }

  // ── Run 3: the ceiling is a real ceiling ──────────────────────────────────
  console.log('\n── Run 3: 5 urls, ceiling 5 ──');
  const full = new FlowChartExecutor(buildChart({ maxBranches: 5 }));
  await full.run();
  const fullState = full.getSnapshot().sharedState as unknown as State;
  console.log('  branches started:', fullState.fetched.length);
  console.log('  succeeded:', fullState.fetched.filter(Boolean).length, '/ failed:', fullState.fetched.filter((f) => !f).length);
})();
