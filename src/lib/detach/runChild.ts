/**
 * detach/runChild.ts — The "how do I actually run a child flowchart?" hook.
 *
 * Pattern:  Strategy (GoF). Drivers are decoupled from the FlowChartExecutor
 *           — each driver is created with a `ChildRunner` it calls to
 *           materialize the work. Default implementation imports the
 *           executor lazily so drivers can be picked up by tree-shakers
 *           that don't pull the runner module into the bundle.
 * Role:     Glue between drivers and the engine. Without this seam, every
 *           driver would have to import `FlowChartExecutor` directly,
 *           creating circular import risk and bundle bloat.
 *
 * Why a separate module (not inlined in each driver):
 *   - DRY — every driver shares the same "instantiate executor, run, return
 *     result" sequence
 *   - Allows test code to swap the runner via factory injection without
 *     having to rebuild the whole driver
 *   - Future-proofs for the case where we want to inject env/recorders
 *     into the child (the runner is the natural place to do that)
 */

import type { FlowChart } from '../builder/types.js';

/**
 * Function the driver calls to actually execute the child flowchart.
 * Returns a Promise resolving to the chart's terminal value (whatever
 * `FlowChartExecutor.run()` resolves with), or rejects on failure.
 *
 * Drivers wrap this in their own try/catch so the rejection routes to
 * `handle._markFailed()` instead of escaping into the parent context
 * (passive-recorder rule).
 */
export type ChildRunner = (child: FlowChart, input: unknown) => Promise<unknown>;

/**
 * Default runner — instantiates a fresh `FlowChartExecutor` for each
 * child and awaits its run. Returns the executor's traversal result.
 *
 * Lazy-imports `FlowChartExecutor` so drivers that consumers create with
 * their own runner don't pull the engine into their bundle.
 *
 * Uses dynamic import — see https://v8.dev/features/dynamic-import.
 */
export const defaultRunChild: ChildRunner = async (child, input) => {
  // Lazy import keeps tree-shakers honest for consumers who pass a
  // custom runner (e.g., a worker-thread bridge).
  const { FlowChartExecutor } = await import('../runner/FlowChartExecutor.js');
  // The executor expects an unknown-typed FlowChart; cast at the boundary
  // since the FlowChart shape is generic-erased at the detach level.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const executor = new FlowChartExecutor(child as any);
  return executor.run({ input });
};
