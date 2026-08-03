/**
 * Structured values through the TypedScope proxy — what you read is what is there
 *
 * A stage reads `scope.results` and gets a Proxy, not the raw object. That
 * Proxy has to behave like the value it stands for, through EVERY door a
 * consumer might use: property access, Object.keys, spread, for...in, and
 * JSON.stringify. If one of those doors disagrees with the others, you get a
 * bug that only shows up once real data — nested objects — flows through it.
 *
 * This example runs the shape that used to break: a subflow whose outputMapper
 * merges an object-of-objects into the parent scope. Every door is compared
 * against `$getValue`, the untyped escape hatch that reads state directly.
 *
 * It also shows the second half of the same law: copying one key to another
 * (`scope.copy = scope.results`) COMMITS the whole structure, so the commit
 * log — the thing your trace, slice and replay are built from — carries the
 * real value.
 *
 * Run: npx tsx examples/runtime-features/typed-scope/01-structured-values.ts
 */

import { flowChart, FlowChartBuilder, FlowChartExecutor } from 'footprintjs';

interface Review {
  score: number;
  notes: string[];
}

interface ParentState {
  chunks: number;
  results: Record<string, Review>;
  archived: Record<string, Review>;
  report: string;
}

// -- A subflow that produces two OBJECT-valued results -------------------------

const reviewSubflow = new FlowChartBuilder<any, any>()
  .start(
    'Review',
    async (scope: any) => {
      scope.intro = { score: 4, notes: ['clear', 'short'] };
      scope.body = { score: 2, notes: ['needs evidence'] };
    },
    'review',
  )
  .build();

// -- The parent chart ---------------------------------------------------------

const chart = flowChart<ParentState>(
  'Plan',
  async (scope) => {
    scope.chunks = 2;
  },
  'plan',
)
  .addSubFlowChartNext('reviewing', reviewSubflow, 'Reviewing', {
    inputMapper: () => ({}),
    // A STRUCTURED merge: the parent key holds objects, not scalars.
    outputMapper: (out: any) => ({ results: { intro: out.intro, body: out.body } }),
  })
  .addFunction(
    'Summarize',
    async (scope) => {
      const viaProperty = scope.results; // the Proxy
      const viaGetValue = scope.$getValue('results') as Record<string, Review>; // the raw state value

      // 1. Every read door agrees.
      console.log('  keys      :', Object.keys(viaProperty).join(', '));
      console.log('  spread    :', JSON.stringify({ ...viaProperty }));
      console.log('  stringify :', JSON.stringify(viaProperty));
      console.log('  $getValue :', JSON.stringify(viaGetValue));
      console.log('  agree?    :', JSON.stringify(viaProperty) === JSON.stringify(viaGetValue));

      // 2. Nesting survives all the way down.
      console.log('  body notes:', scope.results.body.notes.join(' / '));

      // 3. Copying a structured value commits the WHOLE thing.
      scope.archived = scope.results;

      const ranked: Array<[string, Review]> = Object.entries(scope.results);
      const worst = ranked.sort((a, b) => a[1].score - b[1].score)[0];
      scope.report = `lowest: ${worst[0]} (${worst[1].score})`;
    },
    'summarize',
  )
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  await executor.run();

  const snapshot = executor.getSnapshot();
  console.log('\n=== Structured values through TypedScope ===\n');
  console.log('  report    :', (snapshot.sharedState as any).report);

  // The commit log is what a trace, a slice and a replay are built from —
  // so this is where a truncated copy would have done its real damage.
  const summarize = snapshot.commitLog.find((b) => b.stageId === 'summarize');
  console.log('  committed :', JSON.stringify({ ...summarize?.overwrite, ...summarize?.updates }));

  // The escape hatch is still there when you want the raw value with no proxy
  // in the way — e.g. before structuredClone, which cannot clone a Proxy.
  console.log('  cloneable :', JSON.stringify(structuredClone((snapshot.sharedState as any).archived)));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
