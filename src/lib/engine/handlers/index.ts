/* istanbul ignore file */
/**
 * Barrel export for all engine handler modules.
 */

// Stage execution
export { StageRunner } from './StageRunner.js';

// Node resolution and subflow reference handling
export { NodeResolver } from './NodeResolver.js';

// Parallel children execution
export type { ExecuteNodeFn } from './ChildrenExecutor.js';
export { ChildrenExecutor } from './ChildrenExecutor.js';

// Single-choice conditional branching
export type { CallExtractorFn, GetStagePathFn, RunStageFn } from './DeciderHandler.js';
export { DeciderHandler } from './DeciderHandler.js';

// Multi-choice filtered fan-out
export { SelectorHandler } from './SelectorHandler.js';

// Back-edge resolution + iteration counting (was LoopHandler)
export { ContinuationResolver, DEFAULT_MAX_ITERATIONS } from './ContinuationResolver.js';

// Subflow execution with isolated contexts
export { SubflowExecutor } from './SubflowExecutor.js';

// Subflow input/output mapping
export {
  applyOutputMapping,
  createSubflowHandlerDeps,
  extractParentScopeValues,
  getInitialScopeValues,
  seedSubflowGlobalStore,
} from './SubflowInputMapper.js';

// Traversal extractor coordination
export { ExtractorRunner } from './ExtractorRunner.js';

// Runtime structure management (dynamic pipeline structure tracking)
export { computeNodeType, RuntimeStructureManager } from './RuntimeStructureManager.js';
