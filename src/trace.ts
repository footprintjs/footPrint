/**
 * footprintjs/trace — Execution tracing, debugging, and backtracking utilities.
 *
 * Runtime stage IDs, commit log queries, and keyed recorder base class.
 *
 * @example
 * ```typescript
 * import { parseRuntimeStageId, findLastWriter, KeyedRecorder } from 'footprintjs/trace';
 *
 * // Parse a runtimeStageId
 * const { stageId, executionIndex } = parseRuntimeStageId('call-llm#5');
 *
 * // Backtrack: who wrote 'systemPrompt' before stage at idx 8?
 * const writer = findLastWriter(commitLog, 'systemPrompt', 8);
 *
 * // Build a keyed recorder
 * class MyRecorder extends KeyedRecorder<MyEntry> { ... }
 * ```
 */

// Runtime stage ID — unique execution step identifiers
export type { ExecutionCounter } from './lib/engine/runtimeStageId.js';
export { buildRuntimeStageId, createExecutionCounter, parseRuntimeStageId } from './lib/engine/runtimeStageId.js';

// Commit log queries — typed utilities for backtracking
export { findCommit, findCommits, findLastWriter } from './lib/memory/commitLogUtils.js';

// KeyedRecorder — base class for Map-based recorders
export { KeyedRecorder } from './lib/recorder/KeyedRecorder.js';
