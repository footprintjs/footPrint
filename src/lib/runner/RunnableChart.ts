/**
 * RunnableChart -- Adds .recorder(), .redact(), .run() to a FlowChart object.
 *
 * Called by FlowChartBuilder.build() to enrich the compiled chart with
 * d3-style chainable run methods. The chart data is still a plain object;
 * the methods are added as properties.
 */

import type { FlowRecorder } from '../engine/narrative/types.js';
import type { FlowChart, RunOptions } from '../engine/types.js';
import type { Recorder, RedactionPolicy } from '../scope/types.js';
import { type RunResult, RunContext } from './RunContext.js';

/** FlowChart with d3-style .recorder(), .redact(), .run() methods. */
export interface RunnableFlowChart<TOut = any, TScope = any> extends FlowChart<TOut, TScope> {
  /** Attach a recorder for the next run. Returns a chainable RunContext. */
  recorder(r: Recorder | FlowRecorder): RunContext<TOut, TScope>;
  /** Set redaction policy for the next run. Returns a chainable RunContext. */
  redact(policy: RedactionPolicy): RunContext<TOut, TScope>;
  /** Execute the chart directly (bare run, no recorders). */
  run(options?: RunOptions): Promise<RunResult>;
}

/**
 * Enrich a FlowChart with .recorder(), .redact(), .run() methods.
 * Called by FlowChartBuilder.build().
 */
export function makeRunnable<TOut, TScope>(chart: FlowChart<TOut, TScope>): RunnableFlowChart<TOut, TScope> {
  const runnable = chart as RunnableFlowChart<TOut, TScope>;

  runnable.recorder = function (r: Recorder | FlowRecorder): RunContext<TOut, TScope> {
    return new RunContext(chart).recorder(r);
  };

  runnable.redact = function (policy: RedactionPolicy): RunContext<TOut, TScope> {
    return new RunContext(chart).redact(policy);
  };

  runnable.run = function (options?: RunOptions): Promise<RunResult> {
    return new RunContext(chart).run(options);
  };

  return runnable;
}
