/**
 * Deferred Observers — Basic (RFC-001)
 *
 * One option flips a recorder off the engine's hot path:
 *
 *   executor.attachScopeRecorder(rec, { delivery: 'deferred', capture: 'clone' })
 *
 * Events are captured into ONE bounded, totally-ordered queue and delivered
 * at the next microtask checkpoint — "one beat behind", never blocking a
 * stage, fully drained before run() returns (terminal flush).
 *
 * This example runs the SAME chart twice — once with an inline recorder,
 * once with the identical recorder attached deferred (capture: 'clone') —
 * and shows:
 *   1. the recorder observes the SAME event log either way;
 *   2. the built-in narrative is byte-identical either way;
 *   3. only the DELIVERY TIMING differs (deferred events land at
 *      checkpoints, not inside the producing statement).
 *
 * Capture policies: 'summary' (default) hands your hooks a bounded,
 * reference-free PayloadSummary; 'clone' hands a structuredClone of the
 * event (same shape as inline — used here so the logs compare equal);
 * 'ref' hands the live event object (dev-warned).
 *
 * Run: npm run example -- examples/runtime-features/deferred-observers/01-basic.ts
 * (build first: npm run build — examples resolve footprintjs to dist/)
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import type { ReadEvent, WriteEvent } from 'footprintjs';

interface OrderState {
  orderId: string;
  total: number;
  status: string;
  [key: string]: unknown;
}

const buildChart = () =>
  flowChart<OrderState>(
    'Intake',
    async (scope) => {
      scope.orderId = 'ord-42';
      scope.total = 129.5;
    },
    'intake',
  )
    .addFunction(
      'Price',
      async (scope) => {
        scope.total = scope.total * 1.08; // tax
      },
      'price',
    )
    .addFunction(
      'Finalize',
      async (scope) => {
        scope.status = `confirmed:${scope.orderId}`;
      },
      'finalize',
    )
    .build();

type LogEntry = { hook: string; key?: string; value?: unknown };

function makeRecorder(log: LogEntry[]) {
  return {
    id: 'audit',
    onWrite: (e: WriteEvent) => log.push({ hook: 'onWrite', key: e.key, value: e.value }),
    onRead: (e: ReadEvent) => log.push({ hook: 'onRead', key: e.key, value: e.value }),
  };
}

async function main() {
  // ── Run 1: the historical INLINE tier ────────────────────────────────────
  const inlineLog: LogEntry[] = [];
  const inlineExec = new FlowChartExecutor(buildChart());
  inlineExec.enableNarrative();
  inlineExec.attachScopeRecorder(makeRecorder(inlineLog));
  await inlineExec.run();

  // ── Run 2: the DEFERRED tier — one options bag, nothing else changes ─────
  const deferredLog: LogEntry[] = [];
  const deferredExec = new FlowChartExecutor(buildChart());
  deferredExec.enableNarrative();
  deferredExec.attachScopeRecorder(makeRecorder(deferredLog), { delivery: 'deferred', capture: 'clone' });
  await deferredExec.run();

  // ── Same events, same narrative ──────────────────────────────────────────
  const sameEvents = JSON.stringify(inlineLog) === JSON.stringify(deferredLog);
  const inlineNarrative = inlineExec.getNarrativeEntries().map((e) => e.text);
  const deferredNarrative = deferredExec.getNarrativeEntries().map((e) => e.text);
  const sameNarrative = JSON.stringify(inlineNarrative) === JSON.stringify(deferredNarrative);

  console.log('observed event logs identical: ', sameEvents);
  console.log('built-in narrative identical:  ', sameNarrative);
  console.log('\nevents the deferred recorder observed (one beat behind, fully delivered):');
  for (const e of deferredLog) console.log(`  ${e.hook.padEnd(8)} ${String(e.key).padEnd(8)} = ${String(e.value)}`);

  console.log('\nobserverStats (Block 9 — present because a deferred observer attached):');
  const stats = deferredExec.getSnapshot().observerStats!;
  console.log(
    `  depth=${stats.depth} drops=${stats.drops} flushes=${stats.flushes} ` +
      `inline=${stats.inlineDeliveries} stranded=${stats.terminalStranded}`,
  );
  console.log(`  per-listener: audit delivered ${stats.perListener.audit.events} events`);

  if (!sameEvents || !sameNarrative) {
    throw new Error('deferred delivery must observe the same record as inline');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
