/**
 * executor/index.ts
 *
 * WHY: Barrel export for the executor module.
 * Provides a single import point for all executor functionality.
 *
 * RESPONSIBILITIES:
 * - Re-export FlowChartExecutor (public API)
 * - Re-export Pipeline (core execution engine)
 * - Re-export all types
 * - Re-export handlers for advanced use cases
 *
 * DESIGN DECISIONS:
 * - FlowChartExecutor is the primary public API
 * - Pipeline is exposed for advanced consumers who need direct access
 * - Types are re-exported for TypeScript consumers
 * - Handlers are re-exported for testing and extension
 *
 * RELATED:
 * - {@link ../index.ts} - Core module barrel that re-exports from here
 * - {@link FlowChartExecutor} - Public API wrapper
 * - {@link Pipeline} - Core execution engine
 */

// Public API
export { FlowChartExecutor } from './FlowChartExecutor';

// Core execution engine
export { Pipeline, isStageNodeReturn } from './Pipeline';
export type { StageNode, Decider, Selector } from './Pipeline';

// Types
export * from './types';

// Handlers (for advanced use cases and testing)
export * from './handlers';
