/**
 * Compose a SequenceStore<T> for an audit-log recorder.
 *
 * The store is COMPOSED as a class field — not inherited. The
 * recorder owns event handling; the store owns storage. One purpose
 * per concern.
 *
 * Run: npx tsx examples/recorders/01-compose-sequence-store.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import { SequenceStore } from 'footprintjs/trace';
import type { ScopeRecorder } from 'footprintjs';

interface AuditEntry {
  runtimeStageId?: string;
  type: 'read' | 'write';
  key: string;
}

class AuditRecorder implements ScopeRecorder {
  readonly id = 'audit';
  private readonly store = new SequenceStore<AuditEntry>();

  onRead(event: { runtimeStageId?: string; key: string }) {
    this.store.push({ runtimeStageId: event.runtimeStageId, type: 'read', key: event.key });
  }
  onWrite(event: { runtimeStageId?: string; key: string }) {
    this.store.push({ runtimeStageId: event.runtimeStageId, type: 'write', key: event.key });
  }

  // Public read API delegates to the store — same shape consumers expect.
  getEntries() { return this.store.getAll(); }
  clear() { this.store.clear(); }
}

const chart = flowChart('init', (scope: any) => {
  scope.x = 1;
  scope.y = scope.x + 2;
}, 'init').build();

(async () => {
  const audit = new AuditRecorder();
  const executor = new FlowChartExecutor(chart);
  executor.attachScopeRecorder(audit);
  await executor.run();

  console.log('audit log:');
  for (const entry of audit.getEntries()) {
    console.log(`  ${entry.type} ${entry.key}`);
  }
})();
