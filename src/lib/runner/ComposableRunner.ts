/**
 * ComposableRunner — interface for runners that expose their internal flowChart.
 *
 * Any runner implementing this interface can be mounted as a subflow
 * in a parent flowChart via `addSubFlowChart(id, runner.toFlowChart())`.
 * This enables UI drill-down: the parent's snapshot contains the child's
 * full execution tree, addressable by subflow ID.
 *
 * Usage:
 *   class MyAgent implements ComposableRunner<string, AgentResult> {
 *     toFlowChart() { return this.chart; }
 *     async run(input) { ... }
 *   }
 *
 *   // Mount in parent
 *   flowChart('Seed', seedFn, 'seed')
 *     .addSubFlowChart('my-agent', agent.toFlowChart(), 'MyAgent')
 *     .build();
 */

import type { FlowChart, RunOptions } from '../engine/types';

/**
 * A runner that can expose its internal flowChart for subflow composition.
 *
 * @typeParam TIn  — the input type accepted by `run()`
 * @typeParam TOut — the output type returned by `run()`
 */
export interface ComposableRunner<TIn = unknown, TOut = unknown> {
  /** Expose the internal flowChart for subflow mounting (enables UI drill-down). */
  toFlowChart(): FlowChart;

  /** Execute the runner. */
  run(input: TIn, options?: RunOptions): Promise<TOut>;
}
