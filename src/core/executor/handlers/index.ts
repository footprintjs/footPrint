/**
 * handlers/index.ts
 *
 * WHY: Barrel export for all executor handler modules.
 * Provides a single import point for consumers needing handler functionality.
 *
 * RESPONSIBILITIES:
 * - Re-export all handler modules from a single location
 * - Enable tree-shaking by using named exports
 *
 * DESIGN DECISIONS:
 * - Each handler is a separate module following Single Responsibility Principle
 * - Handlers are extracted from Pipeline.ts for testability and maintainability
 *
 * RELATED:
 * - {@link Pipeline} - Uses these handlers for execution
 * - {@link ../index.ts} - Re-exports from this barrel
 */

// Stage execution
export { StageRunner } from './StageRunner';

// Node resolution and subflow reference handling
export { NodeResolver } from './NodeResolver';

// Parallel children execution
export { ChildrenExecutor } from './ChildrenExecutor';

// Subflow execution with isolated contexts
export { SubflowExecutor } from './SubflowExecutor';

// Subflow input/output mapping
export {
  extractParentScopeValues,
  getInitialScopeValues,
  createSubflowPipelineContext,
  seedSubflowGlobalStore,
  applyOutputMapping,
} from './SubflowInputMapper';

// Loop and dynamic next handling
export { LoopHandler } from './LoopHandler';

// Decider evaluation and branching
export { DeciderHandler } from './DeciderHandler';

// Scope-based selector evaluation and multi-choice branching
export { SelectorHandler } from './SelectorHandler';

// Runtime structure management (dynamic pipeline structure tracking)
export { RuntimeStructureManager, computeNodeType } from './RuntimeStructureManager';

// Traversal extractor coordination
export { ExtractorRunner } from './ExtractorRunner';
