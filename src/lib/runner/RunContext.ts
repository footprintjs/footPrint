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
import type { ExecutorResult, PausedResult, RunOptions } from '../engine/types.js';
import type { FlowchartCheckpoint } from '../pause/types.js';
import type { CombinedRecorder } from '../recorder/CombinedRecorder.js';
import type { RedactionPolicy, ScopeRecorder } from '../scope/types.js';
import { createRunLifecycle } from './NativeRunLifecycle.js';

/**
 * Result from RunContext.run() — owns state and output.
 *
 * A run that PAUSED resolves too. It is told apart by `paused: true` and carries the `checkpoint`; its
 * `output` is `undefined`, because the chart has not produced one (the output mapper is not asked about
 * half-built state). A run that finished has neither field.
 */
export interface RunResult {
  /** Raw scope state after execution — at the pause, for a run that paused. */
  state: Record<string, unknown>;
  /** Mapped output via contract mapper (if declared). `undefined` for a run that paused. */
  output: unknown;
  /** Full execution tree for debugging. */
  executionTree: unknown;
  /** Commit log for time-travel. */
  commitLog: unknown[];
  /** Present, and `true`, only when the run paused: the stages after the pause have not run. */
  paused?: true;
  /**
   * Present only when the run paused. The short form keeps no executor, so resume on one made from the same
   * chart and set up like the first run. The checkpoint holds raw state by design; the redaction policy and the
   * recorders are configuration, so a bare executor would resume without them and write selected values in full:
   *
   * ```ts
   * const executor = new FlowChartExecutor(chart);
   * executor.setRedactionPolicy(samePolicy); // the policy given to `chart.redact(...)`
   * executor.attachCombinedRecorder(sameRecorder); // each recorder given to `chart.recorder(...)`
   * await executor.resume(result.checkpoint, answer);
   * ```
   */
  checkpoint?: FlowchartCheckpoint;
}

/** The executor's own answer for a run that paused (`FlowChartExecutor · pausedOrThrow`). */
function pauseOf(result: ExecutorResult): PausedResult | undefined {
  return typeof result === 'object' && result !== null && (result as PausedResult).paused === true
    ? (result as PausedResult)
    : undefined;
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
    // Each fluent invocation remains independent; only reusable logical runners
    // retain a lifecycle. The compiled chart itself has no global admission gate.
    const lifecycle = createRunLifecycle(this.chart, { runnerId: 'RunContext' });
    return lifecycle.withRun(async (run) => {
      const pause = pauseOf(
        await run.execute(
          { kind: 'run', options },
          {
            attachments: this.recorders.map((recorder) => ({ recorder })),
            ...(this.redactionPolicy !== undefined && { redaction: this.redactionPolicy }),
          },
        ),
      );
      const snapshot = run.snapshot()!;
      const state = snapshot.sharedState || {};
      // A paused run has no output yet: the mapper is written for the finished state.
      const mapper = (this.chart as any).outputMapper as ((s: Record<string, unknown>) => unknown) | undefined;
      const output = pause ? undefined : mapper ? mapper(state) : snapshot.sharedState;
      return {
        state,
        output,
        executionTree: snapshot.executionTree,
        commitLog: snapshot.commitLog || [],
        ...(pause && { paused: true as const, checkpoint: pause.checkpoint }),
      };
    });
  }
}
