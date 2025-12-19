/**
 * SubflowInputMapper — Pure functions for subflow data contracts.
 *
 * Mental model: Subflow = Pure Function
 * - Isolated scope (own GlobalStore)
 * - Explicit inputs via inputMapper
 * - Explicit outputs via outputMapper
 *
 * | Scenario        | Behavior                                  |
 * |-----------------|-------------------------------------------|
 * | No inputMapper  | Subflow starts with empty scope           |
 * | No outputMapper | Subflow scope changes discarded           |
 * | Both present    | Full data contract (args in, results out) |
 * | Neither present | Complete isolation (side effects only)    |
 */

import type { StageContext } from '../../memory/StageContext';
import type { IExecutionRuntime, SubflowMountOptions, HandlerDeps } from '../types';

/** Extract values from parent scope using inputMapper. */
export function extractParentScopeValues<TParentScope, TSubflowInput>(
  parentScope: TParentScope,
  options?: SubflowMountOptions<TParentScope, TSubflowInput>,
): TSubflowInput | Record<string, unknown> {
  if (!options?.inputMapper) {
    return {};
  }

  const result = options.inputMapper(parentScope);
  if (result === null || result === undefined) {
    return {};
  }

  return result;
}

/**
 * Get the initial scope values for a subflow.
 * Always isolated — only inputMapper values are included.
 */
export function getInitialScopeValues<TParentScope, TSubflowInput>(
  parentScope: TParentScope,
  options?: SubflowMountOptions<TParentScope, TSubflowInput>,
): Record<string, unknown> {
  return extractParentScopeValues(parentScope, options) as Record<string, unknown>;
}

/**
 * Create a new HandlerDeps for subflow execution.
 * Key: sets readOnlyContext to mapped input so StageRunner passes it to ScopeFactory.
 */
export function createSubflowHandlerDeps<TOut = any, TScope = any>(
  parentDeps: HandlerDeps<TOut, TScope>,
  subflowRuntime: IExecutionRuntime,
  mappedInput: Record<string, unknown>,
): HandlerDeps<TOut, TScope> {
  return {
    stageMap: parentDeps.stageMap,
    root: parentDeps.root,
    ScopeFactory: parentDeps.ScopeFactory,
    subflows: parentDeps.subflows,
    throttlingErrorChecker: parentDeps.throttlingErrorChecker,
    streamHandlers: parentDeps.streamHandlers,
    scopeProtectionMode: parentDeps.scopeProtectionMode,
    executionRuntime: subflowRuntime,
    readOnlyContext: mappedInput,
    narrativeGenerator: parentDeps.narrativeGenerator,
    logger: parentDeps.logger,
  };
}

/**
 * Seed the subflow's GlobalStore with initial values.
 * Called before subflow execution to make inputMapper values available.
 */
export function seedSubflowGlobalStore(
  subflowRuntime: IExecutionRuntime,
  initialValues: Record<string, unknown>,
): void {
  const rootContext = subflowRuntime.rootStageContext;

  for (const [key, value] of Object.entries(initialValues)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        rootContext.setObject([key], nestedKey, nestedValue);
      }
    } else {
      rootContext.setGlobal(key, value);
    }
  }

  rootContext.commit();
}

/**
 * Apply output mapping after subflow completion.
 * Writes mapped values back to parent scope using merge semantics:
 * arrays are appended, objects are shallow-merged, scalars are replaced.
 */
export function applyOutputMapping<TParentScope, TSubflowOutput>(
  subflowOutput: TSubflowOutput,
  parentScope: TParentScope,
  parentContext: StageContext,
  options?: SubflowMountOptions<TParentScope, any, TSubflowOutput>,
): Record<string, unknown> | undefined {
  if (!options?.outputMapper) {
    return undefined;
  }

  const mappedOutput = options.outputMapper(subflowOutput, parentScope);

  if (mappedOutput === null || mappedOutput === undefined) {
    return undefined;
  }

  for (const [key, value] of Object.entries(mappedOutput)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
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
