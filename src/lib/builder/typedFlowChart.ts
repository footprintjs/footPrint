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
export type TypedStageFunction<T extends Record<string, unknown>> = (scope: TypedScope<T>) => Promise<void> | void;

/**
 * Creates a ScopeFactory that produces TypedScope<T> instances.
 *
 * Pass to FlowChartExecutor as the second argument:
 *   new FlowChartExecutor(chart, createTypedScopeFactory<MyState>())
 */
export function createTypedScopeFactory<T extends Record<string, unknown>>(): ScopeFactory<TypedScope<T>> {
  return ((ctx: any, stageName: string, readOnly?: unknown, env?: any) => {
    const facade = new ScopeFacade(ctx, stageName, readOnly, env);
    return createTypedScope<T>(facade);
  }) as ScopeFactory<TypedScope<T>>;
}

/**
 * Convenience builder for typed pipelines.
 *
 * Usage:
 *   const chart = typedFlowChart<LoanState>('Intake', intakeFn, 'intake')
 *     .addFunction('Process', processFn, 'process')
 *     .build();
 */
export function typedFlowChart<T extends Record<string, unknown>>(
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
