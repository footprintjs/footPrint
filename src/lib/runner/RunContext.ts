/**
 * RunContext -- d3-style chainable run configuration.
 *
 * Returned by chart.recorder() and chart.redact().
 * Accumulates recorders and redaction policy, then creates
 * a FlowChartExecutor internally when .run() is called.
 *
 * The chart is immutable. RunContext is ephemeral per-run config.
 */

import type { FlowChart } from '../builder/types.js';
import type { FlowRecorder } from '../engine/narrative/types.js';
import type { RunOptions } from '../engine/types.js';
import type { CombinedRecorder } from '../recorder/CombinedRecorder.js';
import type { RedactionPolicy, ScopeRecorder } from '../scope/types.js';
import { FlowChartExecutor } from './FlowChartExecutor.js';

/** Result from RunContext.run() — owns state and output. */
export interface RunResult {
  /** Raw scope state after execution. */
  state: Record<string, unknown>;
  /** Mapped output via contract mapper (if declared). */
  output: unknown;
  /** Full execution tree for debugging. */
  executionTree: unknown;
  /** Commit log for time-travel. */
  commitLog: unknown[];
}

export class RunContext<TOut = any, TScope = any> {
  private readonly chart: FlowChart<TOut, TScope>;
  private readonly recorders: CombinedRecorder[] = [];
  private redactionPolicy?: RedactionPolicy;

  constructor(chart: FlowChart<TOut, TScope>) {
    this.chart = chart;
  }

  /**
   * Attach a recorder. Routed through the executor's combined-attach logic at
   * run time, so scope, flow, AND emit channels are all detected uniformly — a
   * recorder that implements only `onEmit` (or any mix) lands on the right
   * channel(s) exactly once. Chainable.
   */
  recorder(r: ScopeRecorder | FlowRecorder | CombinedRecorder): RunContext<TOut, TScope> {
    this.recorders.push(r as CombinedRecorder);
    return this;
  }

  /** Set redaction policy for this run. Chainable. */
  redact(policy: RedactionPolicy): RunContext<TOut, TScope> {
    this.redactionPolicy = policy;
    return this;
  }

  /** Execute the chart with accumulated config. Returns RunResult. */
  async run(options?: RunOptions): Promise<RunResult> {
    const executor = new FlowChartExecutor(this.chart);

    // Attach every recorder via the combined router so scope/flow/emit channels
    // are detected by method shape (flow recorders auto-enable narrative; emit
    // recorders share the scope channel with dedup — no double-attach).
    for (const r of this.recorders) {
      executor.attachCombinedRecorder(r);
    }

    // Set redaction
    if (this.redactionPolicy) {
      executor.setRedactionPolicy(this.redactionPolicy);
    }

    // Run
    await executor.run(options);

    // Build result
    const snapshot = executor.getSnapshot();
    const mapper = (this.chart as any).outputMapper as ((s: Record<string, unknown>) => unknown) | undefined;
    const output = mapper ? mapper(snapshot.sharedState || {}) : snapshot.sharedState;

    return {
      state: snapshot.sharedState || {},
      output,
      executionTree: snapshot.executionTree,
      commitLog: snapshot.commitLog || [],
    };
  }
}
