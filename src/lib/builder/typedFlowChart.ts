/**
 * typedFlowChart<T> -- Convenience builder for TypedScope<T> pipelines.
 *
 * Wraps FlowChartBuilder with the correct TScope generic so stage functions
 * receive typed property access without any casts.
 *
 * Also exports createTypedScopeFactory<T>() which creates the ScopeFactory
 * that wraps ScopeFacade in a TypedScope proxy.
 */

import type { ScopeFactory, StageFunction } from '../engine/types.js';
import { createTypedScope } from '../reactive/createTypedScope.js';
import type { TypedScope } from '../reactive/types.js';
import { ScopeFacade } from '../scope/ScopeFacade.js';
import { FlowChartBuilder } from './FlowChartBuilder.js';
import type { BuildTimeExtractor } from './types.js';

/**
 * Clean stage function type for TypedScope users.
 * No breakPipeline parameter — use scope.$break() instead.
 */
export type TypedStageFunction<T extends object> = (scope: TypedScope<T>) => Promise<void> | void;

/**
 * Creates a ScopeFactory that produces TypedScope<T> instances.
 *
 * Pass to FlowChartExecutor as the second argument:
 *   new FlowChartExecutor(chart, createTypedScopeFactory<MyState>())
 */
export function createTypedScopeFactory<T extends object>(): ScopeFactory<TypedScope<T>> {
  return ((ctx: any, stageName: string, readOnly?: unknown, env?: any) => {
    const facade = new ScopeFacade(ctx, stageName, readOnly, env);
    return createTypedScope<T>(facade);
  }) as ScopeFactory<TypedScope<T>>;
}

/**
 * Convenience builder for typed pipelines.
 *
 * @deprecated Use {@link flowChart} instead. `flowChart<T>(name, fn, id)` is identical
 * to `typedFlowChart<T>(name, fn, id)` and auto-embeds the TypedScope factory at build time.
 * `typedFlowChart` will be removed in a future major version.
 * No changes to executor construction are required — `build()` now embeds the scope factory automatically.
 *
 * Migration:
 * ```typescript
 * // Before:
 * import { typedFlowChart } from 'footprintjs/advanced';
 * const chart = typedFlowChart<LoanState>('Intake', fn, 'intake').build();
 *
 * // After:
 * import { flowChart } from 'footprintjs';
 * const chart = flowChart<LoanState>('Intake', fn, 'intake').build();
 * ```
 */
export function typedFlowChart<T extends object>(
  name: string,
  fn: TypedStageFunction<T>,
  id: string,
  buildTimeExtractor?: BuildTimeExtractor<any>,
  description?: string,
): FlowChartBuilder<any, TypedScope<T>> {
  return new FlowChartBuilder<any, TypedScope<T>>(buildTimeExtractor).start(
    name,
    fn as unknown as StageFunction<any, TypedScope<T>>,
    id,
    description,
  );
}
