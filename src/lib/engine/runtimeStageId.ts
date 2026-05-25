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
 * Naming-collision warning
 * ────────────────────────
 *   The parsed-output `.stageId` field below is the LOCAL form (segment
 *   after the last '/'). This is NOT the same as `spec.id` / `node.id`
 *   for subflow-nested stages, which carry the FULL prefixed form
 *   (`'sf-tools/execute-tool-calls'`). To compare safely, use
 *   `splitStageId(spec.id)` to decompose the prefixed form the same
 *   way `parseRuntimeStageId` decomposes a runtimeStageId.
 *
 * @example
 * ```
 * buildRuntimeStageId('call-llm', 5)                    // 'call-llm#5'
 * buildRuntimeStageId('execute-tool-calls', 8, 'sf-tools') // 'sf-tools/execute-tool-calls#8'
 * buildRuntimeStageId('validate', 3, 'sf-outer/sf-inner')  // 'sf-outer/sf-inner/validate#3'
 * ```
 */

/**
 * Build a runtimeStageId from its components.
 *
 * Note: The traverser does NOT use the subflowPath parameter — node.id already
 * includes the subflow prefix from the builder. This parameter exists for external
 * consumers constructing IDs from parsed components (round-trip via parseRuntimeStageId).
 */
export function buildRuntimeStageId(stageId: string, executionIndex: number, subflowPath?: string): string {
  const prefix = subflowPath ? `${subflowPath}/` : '';
  return `${prefix}${stageId}#${executionIndex}`;
}

/**
 * Parse a runtimeStageId into its components.
 *
 * IMPORTANT — naming collision: the returned `stageId` is the LOCAL
 * form (the segment between the last '/' and the '#'). This is NOT
 * the same as `spec.id` or `node.id` for subflow-nested stages,
 * which contain the FULL prefixed form.
 *
 *   parseRuntimeStageId('sf-tools/execute-tool-calls#8').stageId
 *   // → 'execute-tool-calls'   (LOCAL)
 *
 *   node.id  // (post-mount, in a spec that contains subflows)
 *   // → 'sf-tools/execute-tool-calls'   (FULL prefixed)
 *
 * To compare these two safely, use `splitStageId(node.id)` to get
 * the local form, OR reconstruct the full form via
 * `(subflowPath ? subflowPath + '/' : '') + stageId`.
 */
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
 * Decompose a (possibly prefixed) stage id into its components.
 *
 * Use this when you have an id WITHOUT the `#N` execution suffix and
 * need the local stage name and/or the subflow path. Common sources
 * of such ids:
 *   - `spec.id` (post-mount the id includes any subflow prefix)
 *   - `CommitBundle.stageId` (post-mount id)
 *   - `node.id` from xyflow nodes built off the spec
 *   - the segment of `runtimeStageId` BEFORE the `#` (use
 *     `parseRuntimeStageId` directly for full runtimeStageId strings)
 *
 * Mirrors the decomposition `parseRuntimeStageId` performs on the
 * stageId portion of a runtimeStageId, so the two helpers stay in
 * lockstep on naming and behavior.
 *
 * @example
 * splitStageId('sf-tools/execute-tool-calls')
 * // → { localStageId: 'execute-tool-calls', subflowPath: 'sf-tools' }
 *
 * splitStageId('execute-tool-calls')
 * // → { localStageId: 'execute-tool-calls', subflowPath: undefined }
 *
 * splitStageId('sf-outer/sf-inner/validate')
 * // → { localStageId: 'validate', subflowPath: 'sf-outer/sf-inner' }
 */
export function splitStageId(prefixedStageId: string): {
  localStageId: string;
  subflowPath: string | undefined;
} {
  const lastSlash = prefixedStageId.lastIndexOf('/');
  if (lastSlash === -1) {
    return { localStageId: prefixedStageId, subflowPath: undefined };
  }
  return {
    localStageId: prefixedStageId.slice(lastSlash + 1),
    subflowPath: prefixedStageId.slice(0, lastSlash),
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
