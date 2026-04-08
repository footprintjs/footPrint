/**
 * runtimeStageId — unique identifier for each execution step during traversal.
 *
 * Format: [subflowPath/]stageId#executionIndex
 *
 * Components:
 *   stageId        — stable node ID from the builder ('call-llm', 'seed')
 *   executionIndex — monotonic counter incremented per stage execution (0, 1, 2...)
 *   subflowPath    — optional path for subflow stages ('sf-tools', 'sf-outer/sf-inner')
 *
 * Properties:
 *   - Unique within a run (executionIndex never repeats)
 *   - Execution-ordered (sort by executionIndex = execution order)
 *   - Human-readable ('sf-tools/execute-tool-calls#8')
 *   - Parseable (split on '#' for stageId and index, split stageId on '/' for subflow path)
 *
 * @example
 * ```
 * buildRuntimeStageId('call-llm', 5)                    // 'call-llm#5'
 * buildRuntimeStageId('execute-tool-calls', 8, 'sf-tools') // 'sf-tools/execute-tool-calls#8'
 * buildRuntimeStageId('validate', 3, 'sf-outer/sf-inner')  // 'sf-outer/sf-inner/validate#3'
 * ```
 */

/** Build a runtimeStageId from its components. */
export function buildRuntimeStageId(stageId: string, executionIndex: number, subflowPath?: string): string {
  const prefix = subflowPath ? `${subflowPath}/` : '';
  return `${prefix}${stageId}#${executionIndex}`;
}

/** Parse a runtimeStageId into its components. */
export function parseRuntimeStageId(runtimeStageId: string): {
  stageId: string;
  executionIndex: number;
  subflowPath: string | undefined;
} {
  const hashIdx = runtimeStageId.lastIndexOf('#');
  if (hashIdx === -1) {
    return { stageId: runtimeStageId, executionIndex: 0, subflowPath: undefined };
  }

  const beforeHash = runtimeStageId.slice(0, hashIdx);
  const executionIndex = parseInt(runtimeStageId.slice(hashIdx + 1), 10);

  const lastSlash = beforeHash.lastIndexOf('/');
  if (lastSlash === -1) {
    return { stageId: beforeHash, executionIndex, subflowPath: undefined };
  }

  return {
    stageId: beforeHash.slice(lastSlash + 1),
    executionIndex,
    subflowPath: beforeHash.slice(0, lastSlash),
  };
}

/**
 * Shared mutable counter for execution index.
 * Passed by reference to child traversers (subflows) so they
 * continue the global numbering instead of restarting at 0.
 */
export interface ExecutionCounter {
  value: number;
}

/** Create a new execution counter starting at 0. */
export function createExecutionCounter(): ExecutionCounter {
  return { value: 0 };
}
