/**
 * InOutRecorder — captures subflow entry/exit pairs with mapper payloads.
 *
 * Why it exists:
 *   Every subflow execution has two natural step boundaries baked into the
 *   engine — `inputMapper` runs (entry) and `outputMapper` runs (exit). The
 *   pair brackets the subflow's body in time AND carries the data crossing
 *   the boundary.
 *
 *   `TopologyRecorder` captures the SHAPE of composition. `InOutRecorder`
 *   captures the PAYLOADS at each boundary. Together they're the universal
 *   "step" primitive that downstream layers (Lens, custom dashboards)
 *   project — all bound by `runtimeStageId`.
 *
 * What this example shows:
 *   - A two-stage subflow with an inputMapper + outputMapper
 *   - Capturing entry/exit boundaries
 *   - Querying the timeline (`getSteps`), pairs (`getBoundary`), full
 *     stream (`getBoundaries`)
 *   - Nested subflow case (path decomposition)
 *
 * Run:  npx tsx examples/flow-recorders/07-inout-recorder.ts
 */
import { flowChart, FlowChartExecutor } from 'footprintjs';
import { inOutRecorder } from 'footprintjs/trace';

// ── A small subflow that computes a doubling ─────────────────────────
interface Doubler {
  seed: number;
  doubled?: number;
}
const doublerChart = flowChart<Doubler>(
  'Double',
  (s) => {
    s.doubled = (s.seed ?? 0) * 2;
  },
  'double',
  undefined,
  'Double: multiply the seed by 2',
).build();

// ── Outer chart that mounts the doubler with input + output mappers ──
interface Outer {
  amount: number;
  result?: number;
}
const outerChart = flowChart<Outer>(
  'Receive',
  (s) => {
    s.amount = 21;
  },
  'receive',
)
  .addSubFlowChartNext('sf-double', doublerChart, 'Doubling subflow', {
    inputMapper: (parent) => ({ seed: parent.amount }),
    outputMapper: (sub) => ({ result: sub.doubled }),
  })
  .build();

async function basicExample() {
  console.log('── Basic example: one subflow with mappers ──');
  const executor = new FlowChartExecutor(outerChart);
  const inOut = inOutRecorder();
  executor.attachCombinedRecorder(boundaries);

  await executor.run({ input: {} });

  // Timeline projection: just the entry phases, in execution order.
  console.log('\nSteps (timeline):');
  for (const step of inOut.getSteps()) {
    console.log(`  ${step.subflowId.padEnd(20)} runtime=${step.runtimeStageId}  payload=${JSON.stringify(step.payload)}`);
  }

  // Per-step pair lookup: input + output for one execution.
  console.log('\nBoundary pair for the doubling subflow:');
  const step = inOut.getSteps()[0];
  const pair = inOut.getBoundary(step.runtimeStageId);
  console.log(`  entry payload (inputMapper): ${JSON.stringify(pair.entry?.payload)}`);
  console.log(`  exit payload (subflow shared state): ${JSON.stringify(pair.exit?.payload)}`);

  // Full interleaved stream.
  console.log('\nFull boundary stream:');
  for (const b of inOut.getBoundaries()) {
    console.log(`  ${b.phase.padEnd(5)}  ${b.subflowId}  @ ${b.runtimeStageId}`);
  }
}

// ── Nested example: shows subflowPath decomposition ──────────────────
async function nestedExample() {
  console.log('\n\n── Nested example: subflowPath decomposition ──');

  interface Inner {
    seed: number;
    incremented?: number;
  }
  const inner = flowChart<Inner>(
    'Increment',
    (s) => {
      s.incremented = (s.seed ?? 0) + 1;
    },
    'inc',
  ).build();

  interface Mid {
    from: number;
    incremented?: number;
  }
  const mid = flowChart<Mid>(
    'Mid',
    (s) => {
      // Mid stage uses readonly input via getArgs; here we just pass through.
    },
    'mid-noop',
  )
    .addSubFlowChartNext('sf-inner', inner, 'Inner step', {
      inputMapper: (p) => ({ seed: p.from }),
      outputMapper: (s) => ({ incremented: s.incremented }),
    })
    .build();

  interface Root {
    n: number;
    incremented?: number;
  }
  const root = flowChart<Root>(
    'Root',
    (s) => { s.n = 5; },
    'root',
  )
    .addSubFlowChartNext('sf-mid', mid, 'Mid step', {
      inputMapper: (p) => ({ from: p.n }),
      outputMapper: (s) => ({ incremented: s.incremented }),
    })
    .build();

  const executor = new FlowChartExecutor(root);
  const inOut = inOutRecorder();
  executor.attachCombinedRecorder(boundaries);
  await executor.run({ input: {} });

  console.log('\nSteps (with subflowPath):');
  for (const step of inOut.getSteps()) {
    const indent = '  '.repeat(step.depth);
    console.log(`${indent}- depth=${step.depth} subflowId=${step.subflowId.padEnd(22)} path=${JSON.stringify(step.subflowPath)} payload=${JSON.stringify(step.payload)}`);
  }
}

// ── In-progress / paused: entry without exit ─────────────────────────
function inProgressExample() {
  console.log('\n\n── In-progress example: entry without matching exit ──');
  // InOutRecorder is robust to entry-only events. Useful when a subflow
  // pauses (PauseSignal) — exit doesn't fire until resume completes.
  const inOut = inOutRecorder();
  inOut.onSubflowEntry!({
    name: 'AwaitingApproval',
    subflowId: 'sf-pause',
    traversalContext: {
      stageId: 'sf-pause',
      runtimeStageId: 'sf-pause#0',
      stageName: 'AwaitingApproval',
      depth: 0,
    },
    mappedInput: { question: 'Approve $50,000?' },
  });

  const pair = inOut.getBoundary('sf-pause#0');
  console.log(`  entry: ${pair.entry ? 'present' : 'missing'}`);
  console.log(`  exit:  ${pair.exit ? 'present' : 'missing (in-progress / paused)'}`);
  console.log(`  step still appears in timeline: getSteps() length = ${inOut.getSteps().length}`);
}

async function main() {
  await basicExample();
  await nestedExample();
  inProgressExample();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
