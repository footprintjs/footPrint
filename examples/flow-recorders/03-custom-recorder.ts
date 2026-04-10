/**
 * FlowRecorder: Building Custom Recorders
 *
 * Shows three patterns for custom FlowRecorders:
 *   1. Object literal (simplest)
 *   2. Class implementing FlowRecorder (full control)
 *   3. Extending NarrativeFlowRecorder (custom loop strategy)
 *
 * Run:  npm run fr:custom
 * Try it: https://footprintjs.github.io/footprint-playground/samples/custom-recorder
 */

import {
  flowChart,
  
  FlowChartExecutor,
  NarrativeFlowRecorder,
  type FlowRecorder,
  type FlowLoopEvent,
  type FlowDecisionEvent,
  type FlowStageEvent,
} from 'footprintjs';

// ── Pattern 1: Object literal ────────────────────────────────────────────

const consoleLogger: FlowRecorder = {
  id: 'console',
  onStageExecuted: (e) => console.log(`  [log] Executed: ${e.stageName}`),
  onDecision: (e) => console.log(`  [log] Decision: ${e.decider} -> ${e.chosen}`),
  onLoop: (e) => console.log(`  [log] Loop: ${e.target} #${e.iteration}`),
};

// ── Pattern 2: Class with state ──────────────────────────────────────────

class MetricsFlowRecorder implements FlowRecorder {
  readonly id = 'metrics';

  private stageCount = 0;
  private decisionCount = 0;
  private loopIterations = 0;
  private startTime = 0;

  onStageExecuted(_event: FlowStageEvent): void {
    if (this.stageCount === 0) this.startTime = Date.now();
    this.stageCount++;
  }

  onDecision(_event: FlowDecisionEvent): void {
    this.decisionCount++;
  }

  onLoop(_event: FlowLoopEvent): void {
    this.loopIterations++;
  }

  getSummary(): Record<string, number> {
    return {
      stages: this.stageCount,
      decisions: this.decisionCount,
      loops: this.loopIterations,
      durationMs: Date.now() - this.startTime,
    };
  }
}

// ── Pattern 3: Custom loop strategy (extend NarrativeFlowRecorder) ───────

class EverySeventhRecorder extends NarrativeFlowRecorder {
  private suppressed = 0;

  constructor() {
    super('every-7th');
  }

  override onLoop(event: FlowLoopEvent): void {
    // Emit every 7th iteration + always first
    if (event.iteration === 1 || event.iteration % 7 === 0) {
      super.onLoop(event);
    } else {
      this.suppressed++;
    }
  }

  getSuppressed(): number { return this.suppressed; }
}

// ── State interface ──────────────────────────────────────────────────────

interface LoopState {
  counter: number;
  target: number;
  result?: string;
}

// ── Run all three with a loop chart ──────────────────────────────────────

function buildChart() {
  return flowChart<LoopState>('Init', async (scope) => {
    scope.counter = 0;
    scope.target = 15;
  }, 'init')
    .addFunction('Process', async (scope) => {
      scope.counter = scope.counter + 1;
      if (scope.counter >= scope.target) scope.$break();
    }, 'process')
    .loopTo('process')
    .addFunction('Done', async (scope) => {
      scope.result = 'completed';
    }, 'done')
    .build();
}

(async () => {

  console.log('=== Pattern 1: Object Literal (Console Logger) ===\n');

  let executor = new FlowChartExecutor(buildChart());
  executor.attachFlowRecorder(new NarrativeFlowRecorder());
  executor.attachFlowRecorder(consoleLogger);
  await executor.run();
  console.log();

  // ──────────────────────────────────────────────────────────────────────

  console.log('=== Pattern 2: Class with State (Metrics) ===\n');

  const metrics = new MetricsFlowRecorder();
  executor = new FlowChartExecutor(buildChart());
  executor.attachFlowRecorder(metrics);
  await executor.run();
  console.log('  Metrics:', metrics.getSummary());
  console.log();

  // ──────────────────────────────────────────────────────────────────────

  console.log('=== Pattern 3: Custom Strategy (Every 7th) ===\n');

  const every7th = new EverySeventhRecorder();
  executor = new FlowChartExecutor(buildChart());
  executor.attachFlowRecorder(every7th);
  await executor.run();

  const sentences = executor.getFlowNarrative();
  sentences.forEach((line) => console.log(`  ${line}`));
  console.log(`\n  Emitted: ${sentences.filter(s => s.includes('pass')).length}`);
  console.log(`  Suppressed: ${every7th.getSuppressed()}`);

})().catch(console.error);
