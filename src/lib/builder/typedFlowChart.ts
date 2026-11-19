/**
 * typedFlowChart.ts — TypedScope factory for FlowChartExecutor.
 *
 * Exports createTypedScopeFactory<T>() which creates the ScopeFactory
 * that wraps ScopeFacade in a TypedScope proxy.
 */

import type { ScopeFactory } from '../engine/types.js';
import { createTypedScope } from '../reactive/createTypedScope.js';
import type { TypedScope } from '../reactive/types.js';
import { registerNativeNestedScope } from '../scope/runtime.js';
import { ScopeFacade } from '../scope/ScopeFacade.js';

/**
 * Clean stage function type for TypedScope users.
 * No breakPipeline parameter — use scope.$break() instead.
 */
export type TypedStageFunction<T extends object> = (scope: TypedScope<T>) => Promise<void> | void;

/**
 * Creates a ScopeFactory that produces TypedScope<T> instances.
 *
 * `flowChart<T>()` auto-embeds this factory at build time — you rarely need
 * to call this directly. Use it only when constructing a custom executor with
 * a pre-built chart that was NOT created with `flowChart<T>()`.
 *
 *   const factory = createTypedScopeFactory<MyState>();
 *   new FlowChartExecutor(chart, factory)
 *   // or: new FlowChartExecutor(chart, { scopeFactory: factory })
 */
export function createTypedScopeFactory<T extends object>(): ScopeFactory<TypedScope<T>> {
  return ((ctx: any, stageName: string, readOnly?: unknown, env?: any) => {
    const facade = new ScopeFacade(ctx, stageName, readOnly, env);
    const nested = ctx.getPolicy().nestedReadTracking;
    const explanation = nested ? ctx.capture?.explanation : undefined;
    const scope = createTypedScope<T>(facade, {
      ...(nested && {
        readNested: (segments: readonly string[]) =>
          facade.getValueAt(segments.slice(0, -1) as string[], segments[segments.length - 1]),
      }),
      ...(explanation && { onNestedReadGap: explanation.noteUntrackedNestedRead }),
    });
    if (explanation) registerNativeNestedScope(scope, ctx);
    return scope;
  }) as ScopeFactory<TypedScope<T>>;
}
