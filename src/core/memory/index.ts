/**
 * Core Memory Module - Public API for pipeline state management
 * 
 * WHY: This module provides the memory model for pipeline execution:
 * - GlobalStore: Shared state container
 * - StageContext: Stage-scoped state access with atomic commits
 * - PipelineRuntime: Top-level runtime container
 * - StageMetadata: Per-stage metadata collector
 * 
 * DESIGN: Follows the compiler/runtime analogy:
 * - GlobalStore = heap memory
 * - StageContext = stack frame with transaction buffer
 * - PipelineRuntime = VM instance
 * - StageMetadata = diagnostic collector
 */

// Core classes
export { GlobalStore } from './GlobalStore';
export { StageContext, type StageSnapshot } from './StageContext';
export { PipelineRuntime, type NarrativeEntry, type RuntimeSnapshot } from './PipelineRuntime';
export { StageMetadata } from './StageMetadata';

// Types
export type { ScopeFactory } from './types';
