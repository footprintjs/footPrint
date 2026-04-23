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
import type { Recorder, RedactionPolicy } from '../scope/types.js';
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
  private readonly scopeRecorders: Recorder[] = [];
  private readonly flowRecorders: FlowRecorder[] = [];
  private redactionPolicy?: RedactionPolicy;

  constructor(chart: FlowChart<TOut, TScope>) {
    this.chart = chart;
  }

  /** Attach a recorder. Auto-detects scope vs flow recorder. Chainable. */
  recorder(r: Recorder | FlowRecorder): RunContext<TOut, TScope> {
    const hasId = typeof (r as any).id === 'string';
    const isFlowRecorder =
      hasId &&
      (typeof (r as FlowRecorder).onStageExecuted === 'function' ||
        typeof (r as FlowRecorder).onDecision === 'function' ||
        typeof (r as FlowRecorder).onFork === 'function' ||
        typeof (r as FlowRecorder).onNext === 'function');
    const isScopeRecorder =
      hasId &&
      (typeof (r as Recorder).onRead === 'function' ||
        typeof (r as Recorder).onWrite === 'function' ||
        typeof (r as Recorder).onCommit === 'function');

    // CombinedNarrativeRecorder implements BOTH — add to both lists
    if (isFlowRecorder) this.flowRecorders.push(r as FlowRecorder);
    if (isScopeRecorder) this.scopeRecorders.push(r as Recorder);

    // Pure scope recorder (no flow hooks)
    if (!isFlowRecorder && !isScopeRecorder && hasId) {
      this.scopeRecorders.push(r as Recorder);
    }

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

    // Attach scope recorders
    for (const r of this.scopeRecorders) {
      executor.attachRecorder(r);
    }

    // Attach flow recorders (auto-enables narrative)
    for (const r of this.flowRecorders) {
      executor.attachFlowRecorder(r);
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
