/**
 * Emit Channel — User-Authored Structured Events
 *
 * The library's third observer channel (alongside `Recorder` for scope
 * data-flow and `FlowRecorder` for control-flow). Stage code calls
 * `scope.$emit(name, payload)` to surface structured events — token usage,
 * billing metrics, auth decisions, domain milestones — that don't belong
 * in scope state. Every attached `EmitRecorder.onEmit(event)` fires
 * synchronously with auto-enriched context (stageName, runtimeStageId,
 * subflowPath, timestamp, pipelineId).
 *
 * ## Key properties
 *
 * - **Pass-through, not buffered.** Zero allocation when no emit-recorder
 *   is attached. Events delivered synchronously, in call order.
 * - **Auto-enriched.** Recorders always see stage + subflow context.
 * - **Redaction-aware.** `RedactionPolicy.emitPatterns` scrubs payloads
 *   BEFORE dispatch — no recorder ever sees the raw value for names that
 *   match a pattern.
 * - **Legacy primitives dispatch on this channel too.** `$debug`,
 *   `$metric`, `$error`, `$eval`, `$log` all fire via the emit channel
 *   with namespaced names (`log.debug.${key}`, `metric.${name}`, ...).
 *
 * Run: npx tsx examples/runtime-features/emit/01-custom-events.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import type { EmitEvent, EmitRecorder } from 'footprintjs';

// ── State ──────────────────────────────────────────────────────────────────

interface State {
  request: string;
  response: string;
}

// ── Recorder: capture every emit event for later inspection ────────────────

class CollectingEmitRecorder implements EmitRecorder {
  readonly id = 'collector';
  readonly events: EmitEvent[] = [];

  onEmit(event: EmitEvent): void {
    this.events.push(event);
  }
}

// ── Chart: two stages that emit custom events ──────────────────────────────

const chart = flowChart<State>(
  'CallLLM',
  (scope) => {
    scope.request = 'What is the weather?';

    // Library-enriched: stageName, runtimeStageId, subflowPath, etc. added
    // automatically. Consumer only supplies name + payload.
    scope.$emit('myapp.llm.request', { model: 'claude-sonnet-4', tokens: 142 });
  },
  'call-llm',
)
  .addFunction(
    'HandleResponse',
    (scope) => {
      scope.response = 'Sunny, 72°F.';

      // Four emits from the same stage — arrive at recorders in call order.
      scope.$emit('myapp.llm.tokens', { input: 142, output: 38 });
      scope.$emit('myapp.billing.spend', { cost: 0.0003, currency: 'USD' });
      scope.$emit('myapp.billing.spend', { cost: 0.0002, currency: 'USD' });

      // Legacy $metric: also lands on the emit channel as 'metric.latency'.
      scope.$metric('latency', 234);
    },
    'handle-response',
  )
  .build();

// ── Run + inspect ──────────────────────────────────────────────────────────

(async () => {
  const recorder = new CollectingEmitRecorder();
  const executor = new FlowChartExecutor(chart);
  executor.attachEmitRecorder(recorder);

  // Redaction example: any event whose name matches these patterns has its
  // payload replaced with '[REDACTED]' before dispatch.
  executor.setRedactionPolicy({
    emitPatterns: [/\.billing\./g], // every match is hidden, including repeated names
  });

  await executor.run();

  console.log('=== Emit events captured ===\n');
  for (const e of recorder.events) {
    console.log(`[${e.stageName}] ${e.name}`);
    console.log(`  payload: ${JSON.stringify(e.payload)}`);
    console.log(`  runtimeStageId: ${e.runtimeStageId}`);
    console.log();
  }

  // ── Regression guards — fail the example if invariants break ──

  // We emit 5 events total: 1 in CallLLM + 4 in HandleResponse (3 custom + 1 metric).
  if (recorder.events.length !== 5) {
    console.error(
      `REGRESSION: expected 5 emit events, got ${recorder.events.length}.`,
    );
    process.exit(1);
  }

  // Redaction: BOTH billing events must be masked despite the global flag.
  const billing = recorder.events.filter((e) => e.name === 'myapp.billing.spend');
  if (billing.length !== 2 || billing.some((e) => e.payload !== '[REDACTED]')) {
    console.error(
      'REGRESSION: a repeated billing event payload was not redacted.',
    );
    process.exit(1);
  }

  // Legacy $metric routed through emit channel as 'metric.latency'.
  const latency = recorder.events.find((e) => e.name === 'metric.latency');
  if (!latency) {
    console.error('REGRESSION: $metric did not route through emit channel.');
    process.exit(1);
  }

  // Enrichment: every event has stageName + runtimeStageId.
  for (const e of recorder.events) {
    if (!e.stageName || !e.runtimeStageId) {
      console.error(
        `REGRESSION: event ${e.name} missing enrichment fields.`,
      );
      process.exit(1);
    }
  }

  console.log('OK — all emit-channel invariants hold.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
