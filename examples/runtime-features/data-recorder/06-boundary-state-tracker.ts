/**
 * Feature: BoundaryStateStore — transient bracket-scoped state
 *
 * Three storage primitives sit on the recorder shelf:
 *
 *   • SequenceStore<T>          — append-only event log (durable)
 *   • KeyedStore<T>             — 1:1 entry per runtimeStageId (durable)
 *   • BoundaryStateStore<TState> — live state DURING a [start, stop]
 *                                   bracket; clears on stop  (transient)
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
import { BoundaryStateStore } from 'footprintjs/trace';

// ── Domain state shape ──────────────────────────────────────────────────

interface LLMLiveState {
  readonly partial: string;
  readonly tokens: number;
  readonly startedAtMs: number;
}

// ── Tracker — composes the storage shelf, implements observer interface ──
//
// One purpose per recorder (Convention 1):
//   storage:  BoundaryStateStore<LLMLiveState>  (owned as a field)
//   observer: EmitRecorder                       (the interface this is)

class LiveLLMTracker implements EmitRecorder {
  readonly id = 'live-llm';
  private readonly store = new BoundaryStateStore<LLMLiveState>();

  // Translate emitted events into bracket mutations. The event names
  // are illustrative — wire to whatever your domain emits.
  onEmit(event: EmitEvent): void {
    const key = event.runtimeStageId;
    if (event.name === 'demo.llm.start') {
      this.store.start(key, { partial: '', tokens: 0, startedAtMs: Date.now() });
    } else if (event.name === 'demo.llm.token') {
      const chunk = (event.payload as { content: string }).content;
      this.store.update(key, (s) => ({
        ...s,
        partial: s.partial + chunk,
        tokens: s.tokens + 1,
      }));
    } else if (event.name === 'demo.llm.end') {
      // stop() returns the final state, letting the consumer hand off to
      // durable storage (e.g., push a summary into a SequenceStore).
      this.store.stop(key);
    }
  }

  // Public read API — O(1) at any moment during the run (delegates to the store).
  isInFlight(): boolean {
    return this.store.hasActive;
  }
  getPartial(stageId: string): string {
    return this.store.get(stageId)?.partial ?? '';
  }
  getTokenCount(stageId: string): number {
    return this.store.get(stageId)?.tokens ?? 0;
  }
  getAllActive(): ReadonlyMap<string, LLMLiveState> {
    return this.store.getAll();
  }
  get activeCount(): number {
    return this.store.activeCount;
  }
  clear(): void {
    this.store.clear();
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

  console.log('=== BoundaryStateStore — LiveLLMTracker demo ===\n');
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
