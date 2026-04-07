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
import type { StageContext } from '../../memory/StageContext.js';
import type { HandlerDeps, IExecutionRuntime, SubflowMountOptions } from '../types.js';
/** Extract values from parent scope using inputMapper. */
export declare function extractParentScopeValues<TParentScope, TSubflowInput>(parentScope: TParentScope, options?: SubflowMountOptions<TParentScope, TSubflowInput>): TSubflowInput | Record<string, unknown>;
/**
 * Get the initial scope values for a subflow.
 * Always isolated — only inputMapper values are included.
 */
export declare function getInitialScopeValues<TParentScope, TSubflowInput>(parentScope: TParentScope, options?: SubflowMountOptions<TParentScope, TSubflowInput>): Record<string, unknown>;
/**
 * Create a new HandlerDeps for subflow execution.
 * Key: sets readOnlyContext to mapped input so StageRunner passes it to ScopeFactory.
 */
export declare function createSubflowHandlerDeps<TOut = any, TScope = any>(parentDeps: HandlerDeps<TOut, TScope>, subflowRuntime: IExecutionRuntime, mappedInput: Record<string, unknown>): HandlerDeps<TOut, TScope>;
/**
 * Seed the subflow's GlobalStore with initial values.
 * Called before subflow execution to make inputMapper values available.
 */
export declare function seedSubflowGlobalStore(subflowRuntime: IExecutionRuntime, initialValues: Record<string, unknown>): void;
/**
 * Apply output mapping after subflow completion.
 * Writes mapped values back to parent scope using merge semantics:
 * arrays are appended, objects are shallow-merged, scalars are replaced.
 */
export declare function applyOutputMapping<TParentScope, TSubflowOutput>(subflowOutput: TSubflowOutput, parentScope: TParentScope, parentContext: StageContext, options?: SubflowMountOptions<TParentScope, any, TSubflowOutput>): Record<string, unknown> | undefined;
