/* istanbul ignore file */
/**
 * Barrel export for all engine handler modules.
 */

// Stage execution
export { StageRunner } from './StageRunner';

// Node resolution and subflow reference handling
export { NodeResolver } from './NodeResolver';

// Parallel children execution
export { ChildrenExecutor } from './ChildrenExecutor';
export type { ExecuteNodeFn } from './ChildrenExecutor';

// Single-choice conditional branching
export { DeciderHandler } from './DeciderHandler';
export type { RunStageFn, CallExtractorFn, GetStagePathFn } from './DeciderHandler';

// Multi-choice filtered fan-out
export { SelectorHandler } from './SelectorHandler';

// Back-edge resolution + iteration counting (was LoopHandler)
export { ContinuationResolver, DEFAULT_MAX_ITERATIONS } from './ContinuationResolver';

// Subflow execution with isolated contexts
export { SubflowExecutor } from './SubflowExecutor';

// Subflow input/output mapping
export {
  extractParentScopeValues,
  getInitialScopeValues,
  createSubflowHandlerDeps,
  seedSubflowGlobalStore,
  applyOutputMapping,
} from './SubflowInputMapper';

// Traversal extractor coordination
export { ExtractorRunner } from './ExtractorRunner';

// Runtime structure management (dynamic pipeline structure tracking)
export { RuntimeStructureManager, computeNodeType } from './RuntimeStructureManager';
