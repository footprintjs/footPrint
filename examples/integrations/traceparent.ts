/**
 * Integration: W3C traceparent — find a run from the request that started it
 *
 * A request arrives with a `traceparent` header (W3C Trace Context). Hand it to
 * the run as `env.traceparent` and the run becomes part of that trace: the
 * parsed correlation sits on the snapshot and — the same frozen object — on
 * every recorder event, so an exporter can tag every span or log line with the
 * caller's trace id without threading it through your stages.
 *
 *   env: { traceparent }              → { traceId, operationId, sampled, traceparent }
 *   env: { traceId, operationId }     → { traceId, operationId }   (your own ids)
 *
 * The header comes from whoever sent the request, so it is read STRICTLY: a
 * malformed one refuses the run with a `TraceparentError` whose `reason` names
 * the rule it broke (`version`, `length`, `characters`, `zero-trace-id`, …) —
 * never the header itself. W3C says to start a new trace on a bad header; this
 * example shows that choice explicitly (parse first, drop it on refusal).
 *
 * It is correlation only — never identity, never authorisation.
 *
 * Run: npx tsx examples/integrations/traceparent.ts
 */

import {
  flowChart,
  FlowChartExecutor,
  formatTraceparent,
  parseTraceparent,
  TraceparentError,
  type FlowRecorder,
  type ScopeRecorder,
} from 'footprintjs';

interface Order {
  total: number;
  charged?: boolean;
  [key: string]: unknown;
}

const chart = flowChart<Order>(
  'Price',
  (scope) => {
    scope.total = 42;
  },
  'price',
)
  .addFunction(
    'Charge',
    (scope) => {
      scope.charged = true;
    },
    'charge',
  )
  .build();

// ── An exporter that tags every line with the caller's trace ──────────────

const lines: string[] = [];
const traceOf = (c?: { traceId: string; operationId?: string }) =>
  c ? `trace=${c.traceId.slice(0, 8)}… op=${c.operationId ?? '-'}` : 'trace=(none)';

const flowExporter: FlowRecorder = {
  id: 'flow-exporter',
  onStageExecuted: (e) => lines.push(`stage ${e.stageName.padEnd(7)} ${traceOf(e.traversalContext?.correlation)}`),
};
const scopeExporter: ScopeRecorder = {
  id: 'scope-exporter',
  onWrite: (e) => lines.push(`write ${e.key.padEnd(7)} ${traceOf(e.correlation)}`),
};

/** What an HTTP handler does: accept the header if it is a W3C traceparent, else start fresh (W3C's rule). */
function acceptTraceparent(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  try {
    parseTraceparent(header);
    return header;
  } catch (error) {
    if (error instanceof TraceparentError) {
      console.log(`  inbound traceparent refused (${error.reason}) — starting a new trace`);
      return undefined;
    }
    throw error;
  }
}

async function handle(headers: Record<string, string | undefined>) {
  const executor = new FlowChartExecutor(chart);
  executor.attachFlowRecorder(flowExporter);
  executor.attachScopeRecorder(scopeExporter);
  lines.length = 0;

  const traceparent = acceptTraceparent(headers['traceparent']);
  await executor.run({ env: traceparent ? { traceparent } : {} });

  for (const line of lines) console.log(`  ${line}`);
  return executor.getSnapshot().correlation;
}

async function main() {
  console.log('\n1. A request with a valid traceparent:');
  const correlation = await handle({
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  });
  console.log('  snapshot.correlation =', correlation);

  // Continue the trace on an outbound call: same trace id, YOUR operation as the parent.
  const outbound = formatTraceparent({
    traceId: correlation!.traceId,
    operationId: 'b7ad6b7169203331',
    sampled: correlation!.sampled,
  });
  console.log('  outbound traceparent  =', outbound);

  console.log('\n2. A request with a forged header (never echoed back):');
  const none = await handle({ traceparent: '00-<script>alert(1)</script>-00f067aa0ba902b7-01' });
  console.log('  snapshot.correlation =', none);

  console.log('\n3. Your own ids instead of a header:');
  const executor = new FlowChartExecutor(chart);
  await executor.run({ env: { traceId: 'req-7f3a', operationId: 'checkout' } });
  console.log('  snapshot.correlation =', executor.getSnapshot().correlation);

  // ── Assertions (the example is also a test) ──
  if (correlation?.traceId !== '4bf92f3577b34da6a3ce929d0e0e4736') throw new Error('trace id not carried');
  if (correlation.operationId !== '00f067aa0ba902b7' || correlation.sampled !== true) {
    throw new Error('operation / sampled not carried');
  }
  if (outbound !== '00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01') throw new Error('bad outbound header');
  if (none !== undefined) throw new Error('a refused header must leave no correlation');
  if (executor.getSnapshot().correlation?.operationId !== 'checkout') throw new Error('explicit ids not carried');
  console.log('\n  ✓ correlation carried, refused, and given explicitly');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
