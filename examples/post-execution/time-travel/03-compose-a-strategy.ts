/**
 * Time Travel — composing your own stops out of the library's
 *
 * footprintjs ships one stop grammar, `commitStops`: one stop per executed
 * stage. A domain has a richer one — turns, tool calls, beats — and until
 * 9.18.0 a strategy that FILTERED the shipped axis had to rediscover three
 * things by hand: that the axis is `[start, …stages, end]` (a guard), that the
 * survivors must re-partition the log (arithmetic), and that its own label had
 * nowhere to ride, so it re-derived the classification from the runtimeStageId
 * at every read.
 *
 * `filterStops` does the composition once. `Stop.meta` carries the strategy's
 * vocabulary verbatim. `Stop.prologue` says when `'start'` absorbed stages the
 * axis does not show. `splitAxis` is the guard, stated by the library that
 * owns the shape.
 *
 * Run: npx tsx examples/post-execution/time-travel/03-compose-a-strategy.ts
 */

import { flowChart, FlowChartBuilder, FlowChartExecutor } from 'footprintjs';
import type { TimeTravelStrategy } from 'footprintjs/trace';
import { commitStops, filterStops, splitAxis, stateAt, timeTravel } from 'footprintjs/trace';

// ── The domain's OWN vocabulary — nothing the port knows about ────────────

interface Beat {
  readonly kind: 'turn' | 'tool';
  readonly title: string;
}

const BEATS: Record<string, Beat> = {
  ask: { kind: 'turn', title: 'The question' },
  lookup: { kind: 'tool', title: 'The lookup' },
  answer: { kind: 'turn', title: 'The answer' },
};

/** Classify by the LOCAL stage id, so the same rule works on a drilled log. */
function beatFor(runtimeStageId: string): Beat | null {
  const local = runtimeStageId.split('#')[0].split('/').pop() ?? '';
  return BEATS[local] ?? null;
}

/** The whole strategy: the shipped axis, filtered, with the beat riding on each stop. */
const beatStops: TimeTravelStrategy<Beat> = {
  stopsFor: (log, tree) =>
    filterStops<Beat>(commitStops(log, tree), (stop) => {
      const beat = beatFor(stop.runtimeStageId);
      return beat ? { label: beat.title, meta: beat } : null;
    }),
};

// ── A chart with plumbing a reader would not scrub to ─────────────────────

const inner = new FlowChartBuilder<any, any>()
  .start(
    'Lookup',
    async (scope: any) => {
      scope.found = `row-${scope.needle}`;
    },
    'lookup',
  )
  .build();

const chart = flowChart<any>(
  'Seed',
  async (scope: any) => {
    scope.tenant = 'acme';
    scope.needle = 7;
  },
  'seed',
)
  .addFunction(
    'Prepare',
    async (scope: any) => {
      scope.prepared = true;
    },
    'prepare',
  )
  .addFunction(
    'Ask',
    async (scope: any) => {
      scope.question = 'where?';
    },
    'ask',
  )
  .addSubFlowChartNext('sf-lookup', inner, 'Lookup', {
    inputMapper: (parent: any) => ({ needle: parent.needle }),
    outputMapper: (out: any) => ({ found: out.found }),
  })
  .addFunction(
    'Answer',
    async (scope: any) => {
      scope.answer = `${scope.question} ${scope.found}`;
    },
    'answer',
  )
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  await executor.run();
  const snapshot = executor.getSnapshot();

  // ── Gap 3: the shape is a contract you can read, not guard ─────────────
  console.log('=== splitAxis over commitStops ===\n');
  const axis = splitAxis(commitStops(snapshot.commitLog, snapshot.executionTree));
  if (axis.ok) {
    console.log(`  start.commitIdx=${axis.start.commitIdx}  stages=${axis.stages.length}  end.lastCommitIdx=${axis.end.lastCommitIdx}`);
    console.log(`  stages: ${axis.stages.map((s) => `${s.stageId}(${s.kind})`).join(' → ')}`);
  } else {
    console.log(`  no axis: ${axis.reason}`);
  }

  // ── Gap 1: the beat rides ON the stop ──────────────────────────────────
  console.log('\n=== The beat axis ===\n');
  const cursor = timeTravel(snapshot, { strategy: beatStops });
  for (const stop of cursor.stops) {
    const beat = stop.meta ? `${stop.meta.kind}` : '—';
    const prologue = stop.prologue ? ' prologue' : '';
    console.log(`  ${stop.step}. [${stop.kind}${prologue}] ${stop.label}  beat=${beat}  folds ${stop.commitIdx}..${stop.lastCommitIdx}`);
  }
  // No `beatFor(stop.runtimeStageId)` anywhere above: the strategy already knew.

  // ── Gap 2: what `'start'` folds on a FILTERING axis ─────────────────────
  console.log("\n=== 'start' on the two axes ===\n");
  const perStage = timeTravel(snapshot);
  const rawStart = perStage.stateAt(perStage.stops[0]);
  const beatStart = cursor.stateAt(cursor.stops[0]);
  console.log(`  commitStops start  (prologue=${String(perStage.stops[0].prologue)}): ${Object.keys(rawStart.state).length} keys`);
  console.log(`  beatStops   start  (prologue=${String(cursor.stops[0].prologue)}): ${Object.keys(beatStart.state).length} keys — ${Object.keys(beatStart.state).join(', ')}`);
  // The beat axis's start is the state the FIRST BEAT READ — the fold at the
  // commit just before it — not the run's raw base. Asserted against stateAt:
  const firstBeat = cursor.stops[1];
  const same = JSON.stringify(beatStart.state) === JSON.stringify(stateAt(snapshot, firstBeat.commitIdx - 1).state);
  console.log(`  beatStops start === stateAt(snapshot, ${firstBeat.commitIdx - 1}): ${same}`);

  // ── The same strategy drills ───────────────────────────────────────────
  console.log('\n=== Drilled, same strategy ===\n');
  const mount = perStage.stops.find((s) => s.kind === 'mount');
  const drilled = mount ? cursor.drill(mount.runtimeStageId) : undefined;
  for (const stop of drilled?.stops ?? []) {
    console.log(`  ${stop.step}. [${stop.kind}] ${stop.label}  beat=${stop.meta?.kind ?? '—'}`);
  }
})().catch(console.error);
