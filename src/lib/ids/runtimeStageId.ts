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
 *
 * ## The one owner (F7, 9.37.0)
 *
 * This module is the ONE place the grammar is spelled. Every reader asks it —
 * `isExecutionKey`, `stageIdOf`, `subflowPathOf`, `subflowSegmentsOf`,
 * `lastSegmentOf`, `isWithinSubflow` — and every composer joins through
 * `joinPath` / `buildRuntimeStageId`; no other file splits on `#` or `/`.
 * It builds, parses and reads ids, and imports nothing: it is the record's
 * (C6). The delimiters are RESERVED (RFC 3986 §2.2 style): the engine's id
 * doors refuse them in user-authored ids through ONE function,
 * `reservedIds.ts · refuseReservedId`, which reads them here — so
 * last-delimiter parsing is sound by construction rather than by hope. Stores
 * and the prefixer never refuse — they hold runtime ids and prefixed ids,
 * which carry the delimiters on purpose.
 */

/** Separates subflow path segments from each other and from the stage id. */
export const PATH_DELIMITER = '/';
/** Separates the (prefixed) stage id from the execution index. */
export const EXECUTION_DELIMITER = '#';

// ── Brands (types only — Rust-newtype style; no runtime cost) ──────────────

declare const RUNTIME_STAGE_ID: unique symbol;
declare const EXECUTION_INDEX: unique symbol;
declare const COMMIT_IDX: unique symbol;

/** A `[subflowPath/]stageId#executionIndex` string the grammar produced. Assignable to `string`. */
export type RuntimeStageId = string & { readonly [RUNTIME_STAGE_ID]: true };
/** The run-global, monotonic position of one stage execution (the `#N`). Assignable to `number`. */
export type ExecutionIndex = number & { readonly [EXECUTION_INDEX]: true };
/** A bundle's position in a commit log (`bundle.idx`). Assignable to `number`. */
export type CommitIdx = number & { readonly [COMMIT_IDX]: true };

/**
 * Build a runtimeStageId from its components.
 *
 * Note: The traverser does NOT use the subflowPath parameter — node.id already
 * includes the subflow prefix from the builder. This parameter exists for external
 * consumers constructing IDs from parsed components (round-trip via parseRuntimeStageId).
 */
export function buildRuntimeStageId(stageId: string, executionIndex: number, subflowPath?: string): RuntimeStageId {
  const prefix = subflowPath ? `${subflowPath}${PATH_DELIMITER}` : '';
  return `${prefix}${stageId}${EXECUTION_DELIMITER}${executionIndex}` as RuntimeStageId;
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
  executionIndex: ExecutionIndex;
  subflowPath: string | undefined;
} {
  const hashIdx = runtimeStageId.lastIndexOf(EXECUTION_DELIMITER);
  if (hashIdx === -1) {
    return { stageId: runtimeStageId, executionIndex: 0 as ExecutionIndex, subflowPath: undefined };
  }

  const beforeHash = runtimeStageId.slice(0, hashIdx);
  const executionIndex = parseInt(runtimeStageId.slice(hashIdx + 1), 10) as ExecutionIndex;

  const lastSlash = beforeHash.lastIndexOf(PATH_DELIMITER);
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
  const lastSlash = prefixedStageId.lastIndexOf(PATH_DELIMITER);
  if (lastSlash === -1) {
    return { localStageId: prefixedStageId, subflowPath: undefined };
  }
  return {
    localStageId: prefixedStageId.slice(lastSlash + 1),
    subflowPath: prefixedStageId.slice(0, lastSlash),
  };
}

/**
 * True when `key` names one EXECUTION (`…#N`) rather than a stage or a subflow
 * path. Its presence alone decides: the delimiter is reserved in every
 * user-authored id (`reservedIds.ts · refuseReservedId`), so only the grammar
 * puts it there.
 *
 * Asked where a map is keyed by both — `subflowResults` is dual-keyed by
 * subflow path AND by mount runtimeStageId.
 */
export function isExecutionKey(key: string): boolean {
  return key.includes(EXECUTION_DELIMITER);
}

/**
 * The FULL (subflow-prefixed) stage id of a runtimeStageId — everything before
 * the last `#`, i.e. what `node.id` / `CommitBundle.stageId` hold. A string
 * with no `#` is returned whole.
 *
 * @example stageIdOf('sf-tools/execute#8') // 'sf-tools/execute'
 */
export function stageIdOf(runtimeStageId: string): string {
  const hashIdx = runtimeStageId.lastIndexOf(EXECUTION_DELIMITER);
  return hashIdx === -1 ? runtimeStageId : runtimeStageId.slice(0, hashIdx);
}

/** The execution index of a runtimeStageId, or `NaN` when it carries none. */
export function executionIndexOf(runtimeStageId: string): number {
  const hashIdx = runtimeStageId.lastIndexOf(EXECUTION_DELIMITER);
  return hashIdx === -1 ? NaN : Number.parseInt(runtimeStageId.slice(hashIdx + 1), 10);
}

/**
 * The subflow path a runtimeStageId executes in (`'sf-a/sf-b'`), or
 * `undefined` at the top level. Reads the stage-id part, so it agrees with
 * `splitStageId(stageIdOf(rid)).subflowPath`.
 */
export function subflowPathOf(runtimeStageId: string): string | undefined {
  return splitStageId(stageIdOf(runtimeStageId)).subflowPath;
}

/** The subflow path of a runtimeStageId as segments (`['sf-a', 'sf-b']`); `[]` at the top level. */
export function subflowSegmentsOf(runtimeStageId: string): string[] {
  const path = subflowPathOf(runtimeStageId);
  return path === undefined ? [] : path.split(PATH_DELIMITER);
}

/** The non-empty segments of a subflow path or prefixed id (`'a//b/'` → `['a', 'b']`). */
export function pathSegments(path: string): string[] {
  return path.split(PATH_DELIMITER).filter((s) => s.length > 0);
}

/** The last segment of a path or prefixed id (`'sf-a/sf-b'` → `'sf-b'`); the whole string when it has none. */
export function lastSegmentOf(path: string): string {
  return path.slice(path.lastIndexOf(PATH_DELIMITER) + 1);
}

/** Join path segments with the grammar's delimiter (`joinPath('sf', 'stage')` → `'sf/stage'`). */
export function joinPath(...segments: readonly string[]): string {
  return segments.join(PATH_DELIMITER);
}

/** True when the (prefixed) id `id` sits INSIDE the subflow at `path` — at any depth below it. */
export function isWithinSubflow(id: string, path: string): boolean {
  return id.startsWith(`${path}${PATH_DELIMITER}`);
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
