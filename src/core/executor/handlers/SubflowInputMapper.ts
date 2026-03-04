/**
 * SubflowInputMapper.ts
 *
 * WHY: Provides modular helper functions for subflow input/output mapping.
 * This module is extracted to follow Single Responsibility Principle and enable
 * independent unit testing of mapping logic.
 *
 * ## Mental Model: Subflow = Pure Function
 *
 * A **Subflow** behaves like a **pure function** in programming:
 * ```typescript
 * // Subflow is conceptually like this:
 * function subflow(args: InputType): OutputType {
 *   // internal work with isolated scope (local variables)...
 *   return result;
 * }
 *
 * // Parent calls it like:
 * const result = subflow(inputMapper(parentScope));
 * outputMapper(result) → writes to parentScope
 * ```
 *
 * Key characteristics:
 * - **Isolated scope**: Subflow has its own local variables (GlobalStore)
 * - **No closure**: Cannot access parent scope directly
 * - **Explicit inputs**: Must receive data via `inputMapper` parameters
 * - **Explicit outputs**: Must return data via `outputMapper` return value
 *
 * ## Data Flow Reference
 *
 * | What | How it flows |
 * |------|--------------|
 * | Input to subflow | `inputMapper(parentScope)` → subflow's `readOnlyContext` → `ScopeFactory` → stage scope |
 * | Subflow return value | Last stage's return → available to parent's next stage |
 * | Subflow scope → parent scope | `outputMapper(subflowOutput, parentScope)` → writes to parent GlobalStore |
 * | No outputMapper | Subflow scope changes are discarded (stay in subflow's GlobalStore) |
 *
 * ## Behavior Matrix
 *
 * | Scenario | Behavior |
 * |----------|----------|
 * | No `inputMapper` | Subflow starts with empty scope (like function with no args) |
 * | No `outputMapper` | Subflow scope changes discarded (like void function) |
 * | Both present | Full data contract (args in, results out) |
 * | Neither present | Subflow runs in complete isolation (side effects only) |
 *
 * RESPONSIBILITIES:
 * - Extract values from parent scope using inputMapper
 * - Create subflow PipelineContext with correct readOnlyContext
 * - Seed subflow's GlobalStore with initial values
 * - Apply output mapping after subflow completion
 *
 * DESIGN DECISIONS:
 * - Separation of Concerns: Each helper function has a single responsibility
 * - Testability: Pure functions that can be unit tested independently
 * - Composability: SubflowExecutor composes these helpers rather than implementing inline
 * - Debuggability: Each step can be logged and inspected separately
 *
 * RELATED:
 * - {@link SubflowExecutor} - Uses these helpers for subflow execution
 * - {@link PipelineRuntime} - Provides the GlobalStore that gets seeded
 * - {@link StageContext} - Used for writing output mapping values
 *
 */

import { StageContext } from '../../memory/StageContext';
import { PipelineRuntime } from '../../memory/PipelineRuntime';
import type { SubflowMountOptions, PipelineContext } from '../types';

/**
 * extractParentScopeValues
 * ------------------------------------------------------------------
 * Extracts values from parent scope using the inputMapper function.
 *
 * WHY: This is a pure function that can be unit tested independently.
 * It isolates the inputMapper invocation from the rest of the subflow setup.
 *
 * @param parentScope - The parent flow's scope object
 * @param options - Subflow mount options containing the inputMapper
 * @returns Object of key-value pairs to seed in subflow
 *
 */
export function extractParentScopeValues<TParentScope, TSubflowInput>(
  parentScope: TParentScope,
  options?: SubflowMountOptions<TParentScope, TSubflowInput>
): TSubflowInput | Record<string, unknown> {
  if (!options?.inputMapper) {
    return {};
  }
  
  const result = options.inputMapper(parentScope);
  
  // Handle null/undefined returns as empty object
  if (result === null || result === undefined) {
    return {};
  }
  
  return result;
}

/**
 * getInitialScopeValues
 * ------------------------------------------------------------------
 * Gets the initial scope values for a subflow.
 *
 * WHY: Always uses isolated mode - only inputMapper values are included.
 * This enforces the "subflow = pure function" mental model where subflows
 * only receive data explicitly passed via inputMapper.
 *
 * @param parentScope - The parent flow's scope object
 * @param options - Subflow mount options
 * @returns Object of initial values for subflow's readOnlyContext
 *
 */
export function getInitialScopeValues<TParentScope, TSubflowInput>(
  parentScope: TParentScope,
  options?: SubflowMountOptions<TParentScope, TSubflowInput>
): Record<string, unknown> {
  // SIMPLIFIED: Removed scopeMode handling, always isolated
  // Subflow = Pure Function: only inputMapper values are passed as "arguments"
  return extractParentScopeValues(parentScope, options) as Record<string, unknown>;
}

/**
 * createSubflowPipelineContext
 * ------------------------------------------------------------------
 * Creates a new PipelineContext for subflow execution.
 * 
 * WHY: The key change is setting `readOnlyContext` to the mapped input values,
 * so that StageRunner passes these values to ScopeFactory. This ensures
 * subflow stages can access inputMapper values via their scope.
 *
 * ## Why This Is Needed
 * 
 * The bug was that `inputMapper` values were seeded to subflow's GlobalStore,
 * but `StageRunner` uses `ctx.readOnlyContext` when creating scopes via `ScopeFactory`.
 * Without this fix, stages would receive the parent's `readOnlyContext` instead
 * of the mapped input values.
 *
 * @param parentCtx - The parent pipeline's context
 * @param subflowRuntime - The subflow's isolated PipelineRuntime
 * @param mappedInput - The values from inputMapper to use as readOnlyContext
 * @returns A new PipelineContext for the subflow
 *
 */
export function createSubflowPipelineContext<TOut = any, TScope = any>(
  parentCtx: PipelineContext<TOut, TScope>,
  subflowRuntime: PipelineRuntime,
  mappedInput: Record<string, unknown>
): PipelineContext<TOut, TScope> {
  return {
    // Copy from parent context
    stageMap: parentCtx.stageMap,
    root: parentCtx.root,
    ScopeFactory: parentCtx.ScopeFactory,
    subflows: parentCtx.subflows,
    throttlingErrorChecker: parentCtx.throttlingErrorChecker,
    streamHandlers: parentCtx.streamHandlers,
    scopeProtectionMode: parentCtx.scopeProtectionMode,
    // Override with subflow-specific values
    pipelineRuntime: subflowRuntime,
    readOnlyContext: mappedInput,  // KEY FIX: Use mapped input as readOnlyContext

    // Propagate narrative generator from parent so subflow events are recorded
    narrativeGenerator: parentCtx.narrativeGenerator,
    // Propagate logger from parent so subflow uses the same logger
    logger: parentCtx.logger,
  };
}

/**
 * seedSubflowGlobalStore
 * ------------------------------------------------------------------
 * Seeds the subflow's GlobalStore with initial values.
 *
 * WHY: Called before subflow execution begins to make inputMapper values
 * available to all stages in the subflow via the GlobalStore.
 *
 * DESIGN: Uses the root stage context's setGlobal method to write values
 * to the GlobalStore, making them accessible to all stages in the subflow.
 *
 * @param subflowRuntime - The subflow's PipelineRuntime
 * @param initialValues - Object of key-value pairs to seed
 *
 */
export function seedSubflowGlobalStore(
  subflowRuntime: PipelineRuntime,
  initialValues: Record<string, unknown>
): void {
  const rootContext = subflowRuntime.rootStageContext;
  
  for (const [key, value] of Object.entries(initialValues)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // For nested objects (e.g., { agent: { messages: [...] } }),
      // write each nested key via setObject to use pipeline-namespaced paths.
      // WHY: setGlobal writes to root GlobalStore, but stages read from
      // pipeline-namespaced scope via setObject/getValue. Using setObject
      // ensures the data lands in the correct namespace.
      for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        rootContext.setObject([key], nestedKey, nestedValue);
      }
    } else {
      // Scalar values go to root level via setGlobal (backward compat)
      rootContext.setGlobal(key, value);
    }
  }
  
  // Commit the patch to make values visible immediately
  rootContext.commit();
}

/**
 * applyOutputMapping
 * ------------------------------------------------------------------
 * Applies output mapping after subflow completion.
 *
 * WHY: Writes mapped values back to parent scope, enabling subflows to
 * return data to their parent flow in a controlled way.
 *
 * DESIGN: This is called after the subflow completes successfully.
 * If no outputMapper is provided, returns undefined (no-op).
 *
 * @param subflowOutput - The subflow's final output
 * @param parentScope - The parent flow's scope object
 * @param parentContext - The parent stage's context (for writing)
 * @param options - Subflow mount options containing the outputMapper
 * @returns The mapped output values (for debugging), or undefined if no mapper
 *
 */
export function applyOutputMapping<TParentScope, TSubflowOutput>(
  subflowOutput: TSubflowOutput,
  parentScope: TParentScope,
  parentContext: StageContext,
  options?: SubflowMountOptions<TParentScope, any, TSubflowOutput>
): Record<string, unknown> | undefined {
  if (!options?.outputMapper) {
    return undefined;
  }

  const mappedOutput = options.outputMapper(subflowOutput, parentScope);

  // Handle null/undefined returns
  if (mappedOutput === null || mappedOutput === undefined) {
    return undefined;
  }

  // Write mapped values to parent context using merge semantics.
  // WHY: A subflow is a contributor — it adds data to the parent scope,
  // not replaces it. Arrays are appended, objects are shallow-merged,
  // scalars are replaced. This matches the "subflow as function return"
  // mental model where the return value enriches the caller's state.
  //
  // Uses StageContext.appendToArray() and mergeObject() primitives
  // so the write goes through the standard WriteBuffer → commit path.
  for (const [key, value] of Object.entries(mappedOutput)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // Nested object: merge each nested key with appropriate semantics
      for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        if (Array.isArray(nestedValue)) {
          parentContext.appendToArray([key], nestedKey, nestedValue);
        } else if (typeof nestedValue === 'object' && nestedValue !== null) {
          parentContext.mergeObject([key], nestedKey, nestedValue as Record<string, unknown>);
        } else {
          parentContext.setObject([key], nestedKey, nestedValue);
        }
      }
    } else if (Array.isArray(value)) {
      // Top-level array: append to existing
      const existing = parentContext.getGlobal(key);
      if (Array.isArray(existing)) {
        parentContext.setGlobal(key, [...existing, ...value]);
      } else {
        parentContext.setGlobal(key, value);
      }
    } else {
      parentContext.setGlobal(key, value);
    }
  }

  return mappedOutput;
}
