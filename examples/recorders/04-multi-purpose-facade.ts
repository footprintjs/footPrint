/**
 * Multi-channel recorder via composition (NOT via inheritance).
 *
 * Shows the v5 pattern for a recorder that needs to observe MULTIPLE
 * event channels (scope + flow + emit). Each concern is its own
 * field; the facade class holds them all and implements
 * CombinedRecorder.
 *
 * Run: npx tsx examples/recorders/04-multi-purpose-facade.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import { SequenceStore, KeyedStore } from 'footprintjs/trace';
import type { CombinedRecorder, EmitEvent, ReadEvent, WriteEvent } from 'footprintjs';

interface ScopeOp { runtimeStageId?: string; type: 'read' | 'write'; key: string; }
interface FlowEvt  { runtimeStageId: string; kind: 'subflow.entry' | 'subflow.exit' | 'fork'; name: string; }
interface EmitEvt  { runtimeStageId: string; name: string; }

/**
 * Facade composing 3 stores — one per channel. Each store has ONE
 * purpose. The facade routes events into the right store. No mixing
 * of storage with handler logic.
 */
class MultiChannelRecorder implements CombinedRecorder {
  readonly id = 'multi-channel';

  private readonly scopeOps = new SequenceStore<ScopeOp>();
  private readonly flowEvents = new SequenceStore<FlowEvt>();
  private readonly emitCounts = new KeyedStore<number>();

  // ── ScopeRecorder hooks ───────────────────────────────────
  onRead(e: ReadEvent) {
    this.scopeOps.push({ runtimeStageId: e.runtimeStageId, type: 'read', key: e.key ?? '' });
  }
  onWrite(e: WriteEvent) {
    this.scopeOps.push({ runtimeStageId: e.runtimeStageId, type: 'write', key: e.key });
  }

  // ── FlowRecorder hooks ────────────────────────────────────
  onSubflowEntry(e: { name: string; traversalContext?: { runtimeStageId: string } }) {
    if (!e.traversalContext) return;
    this.flowEvents.push({
      runtimeStageId: e.traversalContext.runtimeStageId,
      kind: 'subflow.entry',
      name: e.name,
    });
  }
  onSubflowExit(e: { name: string; traversalContext?: { runtimeStageId: string } }) {
    if (!e.traversalContext) return;
    this.flowEvents.push({
      runtimeStageId: e.traversalContext.runtimeStageId,
      kind: 'subflow.exit',
      name: e.name,
    });
  }

  // ── EmitRecorder hooks ────────────────────────────────────
  onEmit(e: EmitEvent) {
    if (!e.runtimeStageId) return;
    const cur = this.emitCounts.get(e.runtimeStageId) ?? 0;
    this.emitCounts.set(e.runtimeStageId, cur + 1);
  }

  // Public read API
  getScopeOps() { return this.scopeOps.getAll(); }
  getFlowEvents() { return this.flowEvents.getAll(); }
  getEmitCount(rid: string) { return this.emitCounts.get(rid) ?? 0; }

  clear() {
    this.scopeOps.clear();
    this.flowEvents.clear();
    this.emitCounts.clear();
  }
}

const chart = flowChart('seed', (scope: any) => {
  scope.x = 1;
  scope.$emit('custom.event', { foo: 'bar' });
}, 'seed').build();

(async () => {
  const rec = new MultiChannelRecorder();
  const executor = new FlowChartExecutor(chart);
  executor.attachCombinedRecorder(rec);
  await executor.run();

  console.log(`scope ops: ${rec.getScopeOps().length}`);
  console.log(`flow events: ${rec.getFlowEvents().length}`);
})();
