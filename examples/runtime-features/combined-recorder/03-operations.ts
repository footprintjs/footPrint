/**
 * Recorder Operations — Translate, Accumulate, Aggregate
 *
 * Your code IS the instrumentation. Data is collected during the single DFS
 * traversal. The recorder decides what to compute at COLLECTION time:
 *
 * | Operation   | During Traversal                  | Read Time                |
 * |-------------|-----------------------------------|--------------------------|
 * | Translate   | store(id, entry)                  | getByKey(id)             |
 * | Accumulate  | store(id, { ..., runningTotal })  | getByKey(id).runningTotal|
 * | Aggregate   | store(id, entry)                  | aggregate(fn, init)      |
 *
 * Accumulate = running total computed DURING traversal, stored with each entry.
 * Time-travel UI just reads the pre-computed value. No post-processing.
 */

import {
  flowChart,
  FlowChartExecutor,
  MetricRecorder,
  type StageEvent,
} from 'footprintjs';
import { KeyedRecorder } from 'footprintjs/trace';

// ── Custom CostRecorder (extends KeyedRecorder) ────────────────────────

interface CostEntry {
  stageName: string;
  cost: number;
  /** Running total — accumulated DURING traversal, not computed after. */
  runningTotal: number;
}

class CostRecorder extends KeyedRecorder<CostEntry> {
  readonly id = 'cost-tracker';
  private _runningTotal = 0;   // grows during traversal

  onStageStart(event: StageEvent) {
    // stageId is the unique builder ID (e.g., 'call-llm'), stageName is display name
    const costs: Record<string, number> = {
      'fetch-data': 0.002,
      'call-llm': 0.015,
      'parse-response': 0.001,
      'validate': 0.003,
      'save-result': 0.004,
    };
    const cost = costs[event.stageId] ?? 0.001;
    this._runningTotal += cost;

    // Accumulate: running total stored WITH each entry during traversal
    this.store(event.runtimeStageId, {
      stageName: event.stageName,
      cost,
      runningTotal: this._runningTotal,
    });
  }

  toSnapshot() {
    return {
      name: 'Cost',
      description: 'Accumulator (KeyedRecorder) — running total computed during traversal',
      preferredOperation: 'accumulate' as const,
      data: {
        numericField: 'cost',
        grandTotal: this._runningTotal,
        steps: Object.fromEntries(this.getMap()),
      },
    };
  }

  override clear() {
    super.clear();
    this._runningTotal = 0;
  }
}

// ── State ──────────────────────────────────────────────────────────────

interface PipelineState {
  rawData?: string;
  llmResponse?: string;
  parsed?: Record<string, unknown>;
  valid?: boolean;
  savedId?: string;
}

(async () => {

// ── Build the pipeline ─────────────────────────────────────────────────

const chart = flowChart<PipelineState>(
  'Fetch Data',
  async (scope) => {
    scope.rawData = '{"temp": 72, "humidity": 45, "wind": 12}';
  },
  'fetch-data',
  undefined,
  'Pull sensor data from the API',
)
  .addFunction('Call LLM', async (scope) => {
    scope.llmResponse = `Based on the data ${scope.rawData}, the weather is mild and pleasant.`;
  }, 'call-llm', 'Send data to LLM for analysis')
  .addFunction('Parse Response', async (scope) => {
    scope.parsed = { summary: scope.llmResponse, confidence: 0.92 };
  }, 'parse-response', 'Extract structured data from LLM response')
  .addFunction('Validate', async (scope) => {
    scope.valid = (scope.parsed?.confidence as number) > 0.8;
  }, 'validate', 'Check confidence threshold')
  .addFunction('Save Result', async (scope) => {
    scope.savedId = `result-${Date.now()}`;
  }, 'save-result', 'Persist to database')
  .build();

// ── Attach recorders ───────────────────────────────────────────────────

const costRecorder = new CostRecorder();
const metricRecorder = new MetricRecorder();

const executor = new FlowChartExecutor(chart);
executor.enableNarrative();
executor.attachRecorder(costRecorder);
executor.attachRecorder(metricRecorder);
await executor.run();

// ══════════════════════════════════════════════════════════════════════
// TRAVERSAL COMPLETE — all data collected. Nothing below is "processing"
// — it's just reading what was already computed during traversal.
// ══════════════════════════════════════════════════════════════════════

console.log('Traversal complete. Reading collected data:\n');

// ── TRANSLATE: getByKey(id) → per-step detail ──────────────────────
console.log('┌─ TRANSLATE: getByKey(id) ──────────────────────────┐');
for (const [id] of costRecorder.getMap()) {
  const entry = costRecorder.getByKey(id)!;
  console.log(`  ${id.padEnd(20)} cost=$${entry.cost.toFixed(3)}`);
}
console.log('└─────────────────────────────────────────────────────┘\n');

// ── ACCUMULATE: getByKey(id).runningTotal → pre-computed during traversal
console.log('┌─ ACCUMULATE: getByKey(id).runningTotal ────────────┐');
console.log('  (computed DURING traversal, just reading it now)');
for (const [id] of costRecorder.getMap()) {
  const entry = costRecorder.getByKey(id)!;
  const bar = '█'.repeat(Math.round(entry.runningTotal * 2000));
  console.log(`  ${entry.stageName.padEnd(16)} $${entry.runningTotal.toFixed(3)} ${bar}`);
}
console.log('└─────────────────────────────────────────────────────┘\n');

// ── AGGREGATE: aggregate(fn, init) → grand total ───────────────────
console.log('┌─ AGGREGATE: aggregate(fn, init) ───────────────────┐');
const total = costRecorder.aggregate((sum, e) => sum + e.cost, 0);
console.log(`  Grand total: $${total.toFixed(3)}  (${costRecorder.size} steps)`);
console.log('└─────────────────────────────────────────────────────┘');

})().catch(console.error);
