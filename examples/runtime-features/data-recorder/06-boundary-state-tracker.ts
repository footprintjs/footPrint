/**
 * Feature: BoundaryStateTracker — transient bracket-scoped state
 *
 * Three storage primitives sit on the recorder shelf:
 *
 *   • SequenceRecorder<T>          — append-only event log (durable)
 *   • KeyedRecorder<T>             — 1:1 entry per runtimeStageId (durable)
 *   • BoundaryStateTracker<TState> — live state DURING a [start, stop]
 *                                     bracket; clears on stop  (transient)
 *
 * This example builds a `LiveLLMTracker` for the third shelf — it answers
 * "is an LLM call IN FLIGHT right now, and what's the partial answer so
 * far?" in O(1), without folding the event log. Same pattern works for
 * tool calls (between tool_start and tool_end), agent turns
 * (turn_start/turn_end), or any matched-bracket lifecycle.
 *
 * Run:  npx tsx examples/runtime-features/data-recorder/06-boundary-state-tracker.ts
 */

import {
  flowChart,
  FlowChartExecutor,
  type EmitEvent,
  type EmitRecorder,
} from 'footprintjs';
import { BoundaryStateTracker } from 'footprintjs/trace';

// ── Domain state shape ──────────────────────────────────────────────────

interface LLMLiveState {
  readonly partial: string;
  readonly tokens: number;
  readonly startedAtMs: number;
}

// ── Tracker — extends storage shelf, implements observer interface ──────
//
// Two halves combined into one class:
//   storage:  BoundaryStateTracker<LLMLiveState>  (the new shelf)
//   observer: EmitRecorder                        (existing interface)

class LiveLLMTracker
  extends BoundaryStateTracker<LLMLiveState>
  implements EmitRecorder
{
  readonly id = 'live-llm';

  // Translate emitted events into bracket mutations. The event names
  // are illustrative — wire to whatever your domain emits.
  onEmit(event: EmitEvent): void {
    const key = event.runtimeStageId;
    if (event.name === 'demo.llm.start') {
      this.startBoundary(key, { partial: '', tokens: 0, startedAtMs: Date.now() });
    } else if (event.name === 'demo.llm.token') {
      const chunk = (event.payload as { content: string }).content;
      this.updateBoundary(key, (s) => ({
        ...s,
        partial: s.partial + chunk,
        tokens: s.tokens + 1,
      }));
    } else if (event.name === 'demo.llm.end') {
      // The `final` value lets the subclass do any handoff to durable
      // storage (e.g., emit a summary into a SequenceRecorder).
      this.stopBoundary(key);
    }
  }

  // Public read API — O(1) at any moment during the run.
  isInFlight(): boolean {
    return this.hasActive;
  }
  getPartial(stageId: string): string {
    return this.getActive(stageId)?.partial ?? '';
  }
  getTokenCount(stageId: string): number {
    return this.getActive(stageId)?.tokens ?? 0;
  }
}

// ── Demo flow ─────────────────────────────────────────────────────────

interface DemoState {
  question: string;
  answer?: string;
}

async function streamLLM(scope: {
  $emit: (name: string, payload: unknown) => void;
}): Promise<void> {
  // Simulate an LLM call: emit start, then chunks, then end.
  scope.$emit('demo.llm.start', { provider: 'demo', model: 'demo-model' });
  for (const chunk of ['I will ', 'help you ', 'with that ', 'right now.']) {
    scope.$emit('demo.llm.token', { content: chunk });
    await new Promise((r) => setTimeout(r, 5));
  }
  scope.$emit('demo.llm.end', {});
}

async function main(): Promise<void> {
  const tracker = new LiveLLMTracker();

  const chart = flowChart<DemoState>(
    'Ask',
    async (scope) => {
      scope.question = 'How does the tracker work?';
    },
    'ask',
  )
    .addFunction(
      'CallLLM',
      async (scope) => {
        await streamLLM(scope);
        scope.answer = 'I will help you with that right now.';
      },
      'call-llm',
    )
    .build();

  const executor = new FlowChartExecutor(chart);
  executor.attachEmitRecorder(tracker);

  // Read live state HALFWAY through the run — schedule a peek between
  // chunks. The `setTimeout` interleaves with the streaming loop so we
  // catch the tracker mid-flight at least once.
  const peeks: Array<{ inFlight: boolean; partial: string; tokens: number }> = [];
  const stopPeek = setInterval(() => {
    const callLLMStageId = [...tracker.getAllActive().keys()][0];
    if (callLLMStageId) {
      peeks.push({
        inFlight: tracker.isInFlight(),
        partial: tracker.getPartial(callLLMStageId),
        tokens: tracker.getTokenCount(callLLMStageId),
      });
    }
  }, 8);

  await executor.run();
  clearInterval(stopPeek);

  console.log('=== BoundaryStateTracker — LiveLLMTracker demo ===\n');
  console.log(
    `Peeks during streaming (showing transient state evolving):\n` +
      peeks
        .map(
          (p, i) =>
            `  peek ${i + 1}: inFlight=${p.inFlight}, ` +
            `tokens=${p.tokens}, partial="${p.partial}"`,
        )
        .join('\n'),
  );
  console.log(`\nAfter the run completed:`);
  console.log(`  inFlight=${tracker.isInFlight()}`);
  console.log(`  active boundaries=${tracker.activeCount}`);
  console.log(
    `\nNote: transient state CLEARED on stop. Final answer lives in ` +
      `executor's snapshot / scope, not in the tracker — by design.`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
