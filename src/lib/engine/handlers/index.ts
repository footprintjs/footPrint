/* istanbul ignore file */
/**
 * Barrel export for all engine handler modules.
 */

// Stage execution
export { StageRunner } from './StageRunner';

// Node resolution and subflow reference handling
export { NodeResolver } from './NodeResolver';

// Parallel children execution
export type { ExecuteNodeFn } from './ChildrenExecutor';
export { ChildrenExecutor } from './ChildrenExecutor';

// Single-choice conditional branching
export type { CallExtractorFn, GetStagePathFn, RunStageFn } from './DeciderHandler';
export { DeciderHandler } from './DeciderHandler';

// Multi-choice filtered fan-out
export { SelectorHandler } from './SelectorHandler';

// Back-edge resolution + iteration counting (was LoopHandler)
export { ContinuationResolver, DEFAULT_MAX_ITERATIONS } from './ContinuationResolver';

// Subflow execution with isolated contexts
export { SubflowExecutor } from './SubflowExecutor';

// Subflow input/output mapping
export {
  applyOutputMapping,
  createSubflowHandlerDeps,
  extractParentScopeValues,
  getInitialScopeValues,
  seedSubflowGlobalStore,
} from './SubflowInputMapper';

// Traversal extractor coordination
export { ExtractorRunner } from './ExtractorRunner';

// Runtime structure management (dynamic pipeline structure tracking)
export { computeNodeType, RuntimeStructureManager } from './RuntimeStructureManager';
