/**
 * Snapshot Capture + Replay — ship a run's trace across processes.
 *
 * footprintjs already gives you serializable post-run state. This
 * example shows the canonical pattern for capturing it in one
 * process (e.g., AWS Lambda 1) and replaying it in another (e.g.,
 * Lambda 2, a dev machine, a debugging tool):
 *
 *   ┌──────────────────────────┐   JSON   ┌──────────────────────────┐
 *   │ Process A (capture)      │ ────────►│ Process B (replay)       │
 *   │ ─────────                │  trace   │ ──────────               │
 *   │ executor.run()           │   .json  │ JSON.parse(trace)        │
 *   │ snapshot = ...           │          │ render in <TracedFlow>   │
 *   │ narrative = ...          │          │ feed into custom analysis│
 *   │ spec = chart.buildTime…  │          │ etc.                     │
 *   │ JSON.stringify({ ... })  │          │                          │
 *   └──────────────────────────┘          └──────────────────────────┘
 *
 * Three pieces of state are enough for almost every replay use case:
 *
 *   1. `chart.buildTimeStructure` — the chart's spec (JSON-safe)
 *   2. `executor.getSnapshot()`   — sharedState, commitLog, executionTree
 *   3. `executor.getNarrativeEntries()` — structured narrative entries
 *
 * All three are already serializable — no new primitives needed.
 *
 * Run: npx tsx examples/runtime-features/snapshot-replay/01-capture-and-replay.ts
 */

import { flowChart, FlowChartExecutor, decide } from 'footprintjs';

interface LoanState {
  creditScore: number;
  decision?: string;
}

const chart = flowChart<LoanState>('load', async (scope) => {
  scope.creditScore = 720;
}, 'load')
  .addDeciderFunction('classify', (scope) => {
    return decide(scope, [
      { when: { creditScore: { gt: 700 } }, then: 'approved', label: 'Good credit' },
    ], 'rejected');
  }, 'classify')
    .addFunctionBranch('approved', 'approve', async (scope) => { scope.decision = 'Approved'; })
    .addFunctionBranch('rejected', 'reject', async (scope) => { scope.decision = 'Rejected'; })
    .end()
  .build();

// ── Process A — CAPTURE ─────────────────────────────────────────────

async function captureRun(): Promise<string> {
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();

  const portable = {
    // Build-time spec — JSON-safe by design.
    spec: chart.buildTimeStructure,
    // Post-run snapshot — sharedState + commitLog + executionTree.
    snapshot: executor.getSnapshot(),
    // Narrative entries — structured, indexable by runtimeStageId.
    narrative: executor.getNarrativeEntries(),
    // Optional metadata for the receiver.
    capturedAt: new Date().toISOString(),
    runId: 'demo-run-1',
  };

  return JSON.stringify(portable);
}

// ── Process B — REPLAY (could be a different Lambda, a dev machine,
//                       a browser playground, etc.) ─────────────────

interface CapturedTrace {
  spec: unknown;
  snapshot: { sharedState: Record<string, unknown>; commitLog: unknown[] };
  narrative: Array<{ type: string; text: string; stageName?: string }>;
  capturedAt: string;
  runId: string;
}

function replayTrace(json: string): void {
  const trace: CapturedTrace = JSON.parse(json);

  console.log(`Replay of run ${trace.runId} captured at ${trace.capturedAt}\n`);
  console.log(`Final shared state: ${JSON.stringify(trace.snapshot.sharedState)}`);
  console.log(`Commit log entries: ${trace.snapshot.commitLog.length}\n`);

  console.log('Narrative replay:');
  for (const entry of trace.narrative) {
    if (entry.type === 'stage' || entry.type === 'condition') {
      console.log(`  [${entry.type}] ${entry.text}`);
    }
  }

  // From here, a UI library like `footprint-explainable-ui` can render
  // <TracedFlow chart={trace.spec} snapshot={trace.snapshot} entries={trace.narrative} />
  // with ZERO access to the original process — pure JSON in, full UI out.
}

// ── Demo: capture, ship over (in-memory here), replay ──────────────

async function main(): Promise<void> {
  const wireFormat = await captureRun();
  console.log(`Captured ${wireFormat.length} bytes of trace JSON.\n`);

  // In a real Lambda-to-Lambda flow, this is where you'd
  // `await sqs.sendMessage({ MessageBody: wireFormat })` or
  // `await s3.putObject({ Body: wireFormat })`. The receiver
  // reconstructs the trace via JSON.parse and dispatches:
  replayTrace(wireFormat);
}

main();

// Pattern notes:
//   - Reference equality is LOST in replay (anything that was a live
//     ref in the captured snapshot becomes a deep copy via JSON).
//     This is fine for visualization / inspection; consumers caching
//     by spec identity need to use field-based keys instead.
//   - For per-EVENT replay (firing through recorder onStageExecuted
//     etc. as if the chart just ran), the existing commit log doesn't
//     fully reconstruct the event stream — see proposal #004 backlog.
//     For most visualization / debugging use cases, snapshot + narrative
//     are sufficient.
