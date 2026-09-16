/**
 * time-travel — the READ side, measured: what a reader pays to open a
 * finished run and stand at a stop.
 *
 * Why it exists: the write-side fold was made fast in 9.23 (bench/baseline);
 * the read side — `timeTravel(snapshot)` and `stateAt` at a stop — had no
 * checked-in number, and the decision between "fold forward from the last
 * stop", "checkpoints in the record" and "chunk the record" has to be made
 * from one. Built with footprintjs alone: a linear chart of N stages, each
 * writing one key, run once; the snapshot is then read the way a browser
 * would (a JSON round trip) and folded the way a lens does.
 *
 *   A. record size + JSON round trip (the bytes a browser downloads and parses)
 *   B. timeTravel(snapshot): building the cursor and its commit stops
 *   C. stateAt at the LAST stop: the fold from the base over every delta
 *   D. stateAt at the MIDDLE stop
 *   E. one step forward, as a reader does it: stop k, then stop k+1 (since
 *      9.25.0 the second is one bundle applied to the cursor's memo)
 *
 * Correctness rides along: the fold at the last stop must equal the run's
 * own final state for every key written, or the numbers mean nothing.
 *
 * Run:  npx tsx bench/time-travel.ts            (N defaults to 10 000)
 *       N=1000 npx tsx bench/time-travel.ts
 */
import { flowChart, FlowChartExecutor } from '../src/index';
import { commitStops, timeTravel } from '../src/trace';
import { formatBytes, formatMs, measure, printHeader } from './util';

const N = Number(process.env.N ?? 10_000);
const ROUNDS = Number(process.env.ROUNDS ?? 5);

type State = Record<string, unknown>;

async function build(): Promise<{ snapshot: unknown; finalState: Record<string, unknown> }> {
  let builder = flowChart<State>('S0', async (scope) => scope.$setValue('k_0', 0), 's0');
  for (let i = 1; i < N; i++) {
    const k = `k_${i}`;
    builder = builder.addFunction(`S${i}`, async (scope) => scope.$setValue(k, i), `s${i}`);
  }
  const chart = builder.build();
  const executor = new FlowChartExecutor(chart);
  await executor.run();
  const snapshot = executor.getSnapshot();
  return { snapshot, finalState: snapshot.sharedState as Record<string, unknown> };
}

function sameKeys(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k] === b[k]);
}

async function main(): Promise<void> {
  printHeader(`time-travel read side — ${N} commits, median of ${ROUNDS}`);
  const t0 = performance.now();
  const { snapshot, finalState } = await build();
  console.log(`build + run: ${formatMs(performance.now() - t0)}`);

  // A. the record as bytes, and what a browser pays to parse it. A part that
  // JSON cannot serialise (a recursion too deep for the engine) is REPORTED,
  // and the read side is then measured on the live snapshot.
  let parsed: Parameters<typeof timeTravel>[0] = snapshot as Parameters<typeof timeTravel>[0];
  const parts = snapshot as Record<string, unknown>;
  for (const part of ['sharedState', 'initialState', 'commitLog', 'executionTree', 'subflowResults', 'recorders']) {
    try {
      const bytes = JSON.stringify(parts[part])?.length ?? 0;
      console.log(`A. ${part}: ${formatBytes(bytes)}`);
    } catch (e) {
      console.log(`A. ${part}: JSON.stringify FAILED — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  try {
    const json = JSON.stringify(snapshot);
    const parse = measure(() => {
      JSON.parse(json);
    }, ROUNDS);
    console.log(`A. record ${formatBytes(json.length)} · JSON.parse ${formatMs(parse.median)}`);
    parsed = JSON.parse(json) as Parameters<typeof timeTravel>[0];
  } catch (e) {
    console.log(`A. whole record: JSON.stringify FAILED — ${e instanceof Error ? e.message : String(e)}; reading the live snapshot`);
  }

  // B. the cursor and its stops
  const open = measure(() => {
    timeTravel(parsed);
  }, ROUNDS);
  const tt = timeTravel(parsed);
  console.log(`B. timeTravel(): ${formatMs(open.median)} · ${tt.stops.length} stops`);

  // C. fold at the last stop
  const last = tt.stops[tt.stops.length - 1]!;
  const foldLast = measure(() => {
    tt.stateAt(last);
  }, ROUNDS);
  console.log(`C. stateAt(last): ${formatMs(foldLast.median)}`);

  // D. fold at the middle stop
  const mid = tt.stops[Math.floor(tt.stops.length / 2)]!;
  const foldMid = measure(() => {
    tt.stateAt(mid);
  }, ROUNDS);
  console.log(`D. stateAt(middle): ${formatMs(foldMid.median)}`);

  // E. one step forward as a reader does it today: two folds from the base
  const k = tt.stops.length - 2;
  const step = measure(() => {
    tt.stateAt(tt.stops[k]!);
    tt.stateAt(tt.stops[k + 1]!);
  }, ROUNDS);
  console.log(`E. stop k then k+1 (one step): ${formatMs(step.median)}`);

  // Correctness: the fold at the end IS the run's final state.
  const folded = tt.stateAt(last).state as Record<string, unknown>;
  const ok = sameKeys(folded, finalState);
  console.log(`correctness: fold at last stop ${ok ? 'equals' : 'DIFFERS FROM'} the final state (${Object.keys(finalState).length} keys)`);
  console.log(`commit stops from the log: ${commitStops((parsed as { commitLog: never }).commitLog, (parsed as { executionTree: never }).executionTree).length}`);
  if (!ok) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
