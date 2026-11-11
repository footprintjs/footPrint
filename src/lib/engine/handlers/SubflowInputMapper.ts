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

import { type RedactionRule, MapperTaint } from '../../memory/redaction.js';
import type { NativeMappingBinding } from '../../memory/RunFrame.js';
import type { StageContext } from '../../memory/StageContext.js';
import { unwrapHandles } from '../../reactive/handles.js';
import type { HandlerDeps, IExecutionRuntime, SubflowMountOptions } from '../types.js';
import { isMapperView, watchMapperReads } from './mapperScope.js';
import { isPlainObject } from './plainObject.js';

/**
 * The parent's state as a mapper gets it under a redaction rule. A mapper's own view reports its reads
 * to the taint (`mapperScope.ts · watchMapperReads`), at the cost of the keys read. Anything else (a
 * plain record handed to these helpers directly) is wrapped, as before.
 */
function watched<TParentScope>(taint: MapperTaint, parentScope: TParentScope): TParentScope {
  if (!isMapperView(parentScope)) return taint.watch(parentScope);
  watchMapperReads(parentScope, taint.reads(parentScope));
  return parentScope;
}

/**
 * Extract values from parent scope using inputMapper.
 *
 * What a mapper returns is a VALUE, not a handle: the mapper read the parent's
 * typed scope, so its result may be — or hold — a Proxy bound to the parent
 * stage, and the seed commit below clones it (`structuredClone`, which cannot
 * clone a Proxy). `unwrapHandles` (reactive/handles.ts) swaps each for the
 * value behind it, O(1), Dates and Maps intact; a handle-free result passes
 * through by reference.
 */
export function extractParentScopeValues<TParentScope, TSubflowInput>(
  parentScope: TParentScope,
  options?: SubflowMountOptions<TParentScope, TSubflowInput>,
  rule?: RedactionRule,
  binding?: NativeMappingBinding,
): TSubflowInput | Record<string, unknown> {
  if (!options?.inputMapper) {
    return {};
  }

  // Redaction: a key the mapper writes inherits the redaction of the selected
  // value it copied (`MapperTaint`) — decided here, before the seed is written
  // or narrated. Without a policy or a mark the mapper gets the state itself.
  const taint = MapperTaint.of(rule);
  const raw = options.inputMapper(taint ? watched(taint, parentScope) : parentScope, binding);
  const result = taint ? taint.inherit(raw) : raw;
  if (result === null || result === undefined) {
    return {};
  }

  return unwrapHandles(result);
}

/**
 * Get the initial scope values for a subflow.
 * Always isolated — only inputMapper values are included.
 */
export function getInitialScopeValues<TParentScope, TSubflowInput>(
  parentScope: TParentScope,
  options?: SubflowMountOptions<TParentScope, TSubflowInput>,
  rule?: RedactionRule,
  binding?: NativeMappingBinding,
): Record<string, unknown> {
  return extractParentScopeValues(parentScope, options, rule, binding) as Record<string, unknown>;
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
    scopeFactory: parentDeps.scopeFactory,
    subflows: parentDeps.subflows,
    throttlingErrorChecker: parentDeps.throttlingErrorChecker,
    streamHandlers: parentDeps.streamHandlers,
    scopeProtectionMode: parentDeps.scopeProtectionMode,
    executionRuntime: subflowRuntime,
    readOnlyContext: mappedInput,
    executionEnv: parentDeps.executionEnv, // inherited — like process.env
    narrativeGenerator: parentDeps.narrativeGenerator,
    logger: parentDeps.logger,
  };
}

/**
 * Seed the subflow's GlobalStore with initial values.
 * Called before subflow execution to make inputMapper values available.
 *
 * Redaction: the seed is committed as the subflow's `history[0]` by its root
 * context. `SubflowExecutor` installs the run's redaction rule on that context
 * before calling this, so the commit retains under the policy (9.19.0).
 *
 * `mount` names the seed bundle: the engine passes the MOUNT's frame, because
 * the mount is the stage whose inputMapper produced the seed (R13).
 */
export function seedSubflowGlobalStore(
  subflowRuntime: IExecutionRuntime,
  initialValues: Record<string, unknown>,
  mount?: Pick<StageContext, 'stageName' | 'stageId' | 'runtimeStageId'>,
): void {
  const rootContext = subflowRuntime.rootStageContext;
  // The mount that seeds the subflow names the seed bundle (R13) — all three
  // fields, so its `stageId` is the stage its `runtimeStageId` names. Safe:
  // the engine replaces this root context once the seed is committed.
  // Omitted → the root context's own names and an empty runtimeStageId, the
  // shape every seed had through 9.33.0.
  if (mount) {
    rootContext.stageName = mount.stageName;
    rootContext.stageId = mount.stageId;
    rootContext.runtimeStageId = mount.runtimeStageId;
  }

  for (const [key, value] of Object.entries(initialValues)) {
    // An EMPTY plain object lands whole too: spread into zero writes it
    // seeded nothing, and the child read `undefined` for an `{}` input
    // (9.14.0 to 9.23.3).
    if (isPlainObject(value) && Object.keys(value).length > 0) {
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
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
 *
 * Redaction: every write here goes through `parentContext`'s write funnel,
 * which asks the run's redaction rule — so a policy-redacted or per-call
 * marked key lands in the PARENT's log and mirror as the placeholder (9.19.0).
 */
export function applyOutputMapping<TParentScope, TSubflowOutput>(
  subflowOutput: TSubflowOutput,
  parentScope: TParentScope,
  parentContext: StageContext,
  options?: SubflowMountOptions<TParentScope, any, TSubflowOutput>,
  rule?: RedactionRule,
  binding?: NativeMappingBinding,
): Record<string, unknown> | undefined {
  if (!options?.outputMapper) {
    return undefined;
  }

  // The same boundary in the other direction: the mapper is handed the
  // parent's typed scope too, so what it returns is taken as a value. A key it
  // writes inherits the redaction of the selected value it copied — from the
  // subflow's output or the parent's state — before the merge-back is written.
  const taint = MapperTaint.of(rule);
  const mappedOutput = unwrapHandles(
    taint
      ? taint.inherit(options.outputMapper(taint.watch(subflowOutput), watched(taint, parentScope), binding))
      : options.outputMapper(subflowOutput, parentScope, binding),
  );

  if (mappedOutput === null || mappedOutput === undefined) {
    return undefined;
  }

  for (const [key, value] of Object.entries(mappedOutput)) {
    // A plain object is MERGED field by field (an empty one merges nothing —
    // the parent's value stands); anything else lands whole.
    if (isPlainObject(value)) {
      const fields = Object.entries(value);
      if (fields.length === 0) continue;
      // The fields go INTO what the parent holds under `key`: what comes out is that value with these
      // fields changed, so the mount read it (see the array case below), where its fields are written.
      parentContext.readOwnView(key);
      // And the object is written in pieces, so the write funnel never sees it whole: a selected object
      // the mount read keeps its rule here (the same for each list or object among its fields, which is
      // written as a NEW array or object).
      parentContext.inheritRule([], key, value);
      for (const [nestedKey, nestedValue] of fields) {
        if (Array.isArray(nestedValue)) {
          parentContext.inheritRule([key], nestedKey, nestedValue);
          parentContext.appendToArray([key], nestedKey, nestedValue);
        } else if (typeof nestedValue === 'object' && nestedValue !== null) {
          parentContext.inheritRule([key], nestedKey, nestedValue);
          parentContext.mergeObject([key], nestedKey, nestedValue as Record<string, unknown>);
        } else {
          parentContext.setObject([key], nestedKey, nestedValue);
        }
      }
    } else if (Array.isArray(value)) {
      if (options?.arrayMerge === 'replace') {
        parentContext.setGlobal(key, value);
      } else {
        // The mount READS the parent's array to add to it, so that is a read of the mount like any
        // other (`StageContext · readLiveRoot`). Read untracked, the new array had no source but the
        // subflow: a walk back from it named the mount and lost every stage that had written the
        // elements already there.
        const existing = parentContext.readLiveRoot(key);
        if (Array.isArray(existing)) {
          // Written as a new array: the list the mapper returned keeps its rule (see above).
          parentContext.inheritRule([], key, value);
          parentContext.setGlobal(key, [...existing, ...value]);
        } else {
          parentContext.setGlobal(key, value);
        }
      }
    } else {
      parentContext.setGlobal(key, value);
    }
  }

  return mappedOutput;
}
