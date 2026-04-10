/**
 * Feature: Custom Recorders
 *
 * Recorders observe scope operations (read, write, commit, errors).
 * You can build audit logs, compliance trails, or custom telemetry
 * by implementing the Recorder interface.
 *
 * Run:  npm run feature:recorders
 * Try it: https://footprintjs.github.io/footprint-playground/samples/recorders
 */

import {
  flowChart,
  FlowChartExecutor,
  type Recorder,
  type ReadEvent,
  type WriteEvent,
  type CommitEvent,
} from 'footprintjs';

// ── Custom audit recorder ───────────────────────────────────────────────

class AuditRecorder implements Recorder {
  readonly id = 'audit';
  private log: string[] = [];

  onWrite(event: WriteEvent): void {
    this.log.push(
      `[WRITE] ${event.stageName}: ${event.key} = ${JSON.stringify(event.value)}`,
    );
  }

  onRead(event: ReadEvent): void {
    this.log.push(
      `[READ]  ${event.stageName}: ${event.key} -> ${JSON.stringify(event.value)}`,
    );
  }

  onCommit(event: CommitEvent): void {
    this.log.push(
      `[COMMIT] ${event.stageName}: ${event.mutations.length} mutation(s)`,
    );
  }

  getLog(): string[] {
    return this.log;
  }
}

// ── State interface ─────────────────────────────────────────────────────

interface OrderState {
  userId: string;
  action: string;
  amount: number;
  valid?: boolean;
  result?: string;
}

(async () => {

const auditRecorder = new AuditRecorder();

const chart = flowChart<OrderState>('Input', async (scope) => {
  scope.userId = 'u-123';
  scope.action = 'purchase';
  scope.amount = 99.99;
}, 'input')
  .addFunction('Validate', async (scope) => {
    scope.valid = scope.amount > 0 && scope.amount < 10_000;
  }, 'validate')
  .addFunction('Process', async (scope) => {
    scope.result = scope.valid ? `Processed for ${scope.userId}` : 'Rejected';
  }, 'process')
  .build();

const executor = new FlowChartExecutor(chart);
executor.attachRecorder(auditRecorder);
await executor.run();

console.log('=== Custom Audit Recorder ===\n');
auditRecorder.getLog().forEach((line) => console.log(`  ${line}`));
})().catch(console.error);
