/**
 * backtrack.ts — Backward causal chain analysis on the commit log.
 *
 * Implements **backward program slicing** (Weiser 1984, thin-slice variant):
 * given a starting execution step, walk backwards through read→write
 * dependencies to build the causal DAG that produced the data at that step.
 *
 * ## Algorithm
 *
 * BFS on the implicit dependency graph where edges run from reader → writer.
 *
 * 1. Locate startId in commitLog → root node
 * 2. Get keysRead for root via `getKeysRead` callback
 * 3. For each key read, find who last wrote it before this step → parent commit
 * 4. Create parent CausalNode, link to root.parents
 * 5. Enqueue parent. Repeat until queue empty or limits hit.
 *
 * Output is a **DAG** (not a linked list): a stage reading `creditScore` AND `dti`
 * from different writers has two parents.
 *
 * ## Staged Optimization
 *
 * Two writer-lookup strategies, chosen automatically by commit log size:
 *
 * | Strategy | When | Complexity per lookup |
 * |----------|------|----------------------|
 * | Linear scan | N ≤ 256 | O(N) — simple backward scan |
 * | Reverse index | N > 256 | O(K log N) — prebuilt key→[indices], binary search |
 *
 * The threshold (256) is chosen so the O(N) build cost of the reverse index
 * is amortized over the BFS traversal. Below 256, linear scan wins because
 * there's no index build overhead. The consumer never sees this — `causalChain()`
 * picks the right strategy internally (like a query optimizer choosing between
 * sequential scan vs index scan based on table size).
 *
 * ## Complexity
 *
 * - **Small logs (N ≤ 256):** O(V × K × N) total. V=visited, K=avg keys/node.
 * - **Large logs (N > 256):** O(N × U) index build + O(V × K × log N) lookups.
 *   U = unique keys. Amortized over all BFS hops.
 *
 * ## References
 *
 * - Weiser, M. (1984). "Program Slicing." IEEE TSE.
 * - Sridharan, M. et al. (2007). "Thin Slicing." PLDI.
 *
 * @example
 * ```typescript
 * import { causalChain, flattenCausalDAG, formatCausalChain } from 'footprintjs/trace';
 *
 * const dag = causalChain(commitLog, 'decide#2', (id) => recorder.getKeysRead(id));
 * const flat = flattenCausalDAG(dag);     // BFS-ordered flat list
 * console.log(formatCausalChain(dag));     // human-readable
 * ```
 */

import { findLastWriter } from './commitLogUtils.js';
import type { CommitBundle } from './types.js';

// ── Types ──────────────────────────────────────────────────────────────

/** A single node in the causal DAG. */
export interface CausalNode {
  /** Unique execution step identifier. */
  runtimeStageId: string;
  /** Stable stage identifier. */
  stageId: string;
  /** Human-readable stage name. */
  stageName: string;
  /** Keys this stage wrote (from its CommitBundle.trace). */
  keysWritten: string[];
  /** The key whose read→write dependency linked this node to its child. Empty for the root. */
  linkedBy: string;
  /** BFS depth from the starting node (0 = start). */
  depth: number;
  /** Parent nodes — stages that wrote data this node read. DAG: multiple parents possible. */
  parents: CausalNode[];
}

/** Options for causalChain(). */
export interface CausalChainOptions {
  /** Maximum BFS depth (default: 20). Prevents runaway traversal. */
  maxDepth?: number;
  /** Maximum total nodes to visit (default: 100). Hard cap for safety. */
  maxNodes?: number;
}

/**
 * Callback that returns the keys a stage read during execution.
 * The backtracker calls this for each visited node to determine
 * which read→write edges to follow.
 *
 * Implementors: QualityRecorder tracks keysRead per step,
 * or build a Map<runtimeStageId, string[]> from Recorder.onRead events.
 */
export type KeysReadLookup = (runtimeStageId: string) => string[];

// ── Staged optimization: writer lookup strategies ──────────────────────

/**
 * Threshold for switching from linear scan to reverse index.
 * Below this, O(N) scan is faster (no index build cost).
 * Above this, O(log N) binary search wins.
 */
const REVERSE_INDEX_THRESHOLD = 256;

/**
 * Writer lookup function signature.
 * Returns the CommitBundle that last wrote `key` before position `beforeIdx`.
 */
type WriterLookup = (key: string, beforeIdx: number) => CommitBundle | undefined;

/** Strategy 1: Linear scan — O(N) per lookup, zero setup cost. */
function linearScanLookup(commitLog: CommitBundle[]): WriterLookup {
  return (key, beforeIdx) => findLastWriter(commitLog, key, beforeIdx);
}

/**
 * Strategy 2: Reverse index — O(N×U) build, O(log N) per lookup.
 * Builds a Map<key, sortedIndices[]> where indices are commit positions
 * that wrote that key. Lookup uses binary search to find the last writer
 * before a given position.
 */
function reverseIndexLookup(commitLog: CommitBundle[]): WriterLookup {
  // Build: key → sorted array of commit indices that wrote this key
  const index = new Map<string, number[]>();
  for (let i = 0; i < commitLog.length; i++) {
    for (const t of commitLog[i].trace) {
      let arr = index.get(t.path);
      if (!arr) {
        arr = [];
        index.set(t.path, arr);
      }
      arr.push(i); // already sorted (we iterate in order)
    }
  }

  return (key: string, beforeIdx: number): CommitBundle | undefined => {
    const indices = index.get(key);
    if (!indices || indices.length === 0) return undefined;

    // Binary search: find largest index < beforeIdx
    let lo = 0;
    let hi = indices.length - 1;
    let result = -1;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (indices[mid] < beforeIdx) {
        result = indices[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    return result >= 0 ? commitLog[result] : undefined;
  };
}

/**
 * Staged optimization: pick the right writer-lookup strategy based on data size.
 *
 * Like a database query optimizer choosing between sequential scan and index scan:
 *
 * - **Small log (≤ 256):** Linear scan wins. Zero setup cost, good cache locality.
 *   The overhead of building a reverse index isn't worth it for short logs.
 *
 * - **Large log (> 256):** Reverse index wins. O(N×U) upfront build cost is amortized
 *   across all BFS hops. Each lookup becomes O(log N) via binary search instead of O(N).
 *   For an agent loop with 500 iterations and 5 keys per hop, this is 500×5×log(500)≈22K ops
 *   vs 500×5×500=1.25M ops with linear scan.
 *
 * The caller never sees this — `causalChain()` picks automatically.
 */
function createWriterLookup(commitLog: CommitBundle[]): WriterLookup {
  if (commitLog.length <= REVERSE_INDEX_THRESHOLD) {
    return linearScanLookup(commitLog);
  }
  return reverseIndexLookup(commitLog);
}

// ── Core algorithm ─────────────────────────────────────────────────────

/**
 * Build the causal DAG rooted at `startId` by walking backwards
 * through read→write dependencies in the commit log.
 *
 * Automatically selects the optimal writer lookup strategy:
 * - Linear scan for small logs (≤ 256 commits)
 * - Reverse index with binary search for large logs (> 256 commits)
 *
 * Produces a DAG (not a tree): if two children both read from the same
 * parent, the parent node is shared (deduped by runtimeStageId).
 *
 * @param commitLog   Ordered commit bundles from executor.getSnapshot().commitLog
 * @param startId     runtimeStageId to start backtracking from
 * @param getKeysRead Callback returning keys read by a given execution step
 * @param options     Depth and node limits
 * @returns Root CausalNode with .parents forming the DAG, or undefined if startId not found
 */
export function causalChain(
  commitLog: CommitBundle[],
  startId: string,
  getKeysRead: KeysReadLookup,
  options?: CausalChainOptions,
): CausalNode | undefined {
  const maxDepth = options?.maxDepth ?? 20;
  const maxNodes = options?.maxNodes ?? 100;

  // Build position index: runtimeStageId → array position (O(n) once)
  const idxMap = new Map<string, number>();
  for (let i = 0; i < commitLog.length; i++) {
    idxMap.set(commitLog[i].runtimeStageId, i);
  }

  const startIdx = idxMap.get(startId);
  if (startIdx === undefined) return undefined;

  const startCommit = commitLog[startIdx];

  // Pick writer lookup strategy based on log size
  const findWriter = createWriterLookup(commitLog);

  // Node dedup map: runtimeStageId → CausalNode (ensures DAG, not tree)
  const nodeMap = new Map<string, CausalNode>();

  const root: CausalNode = {
    runtimeStageId: startId,
    stageId: startCommit.stageId,
    stageName: startCommit.stage,
    keysWritten: startCommit.trace.map((t) => t.path),
    linkedBy: '',
    depth: 0,
    parents: [],
  };
  nodeMap.set(startId, root);

  // BFS queue: [node, commitIdx, depth]
  const queue: Array<[CausalNode, number, number]> = [[root, startIdx, 0]];
  let visited = 1;

  while (queue.length > 0) {
    const [node, commitIdx, depth] = queue.shift()!;

    if (depth >= maxDepth) continue;

    const keysRead = getKeysRead(node.runtimeStageId);
    if (keysRead.length === 0) continue;

    // For each key read, find who wrote it
    for (const key of keysRead) {
      const writer = findWriter(key, commitIdx);
      if (!writer) continue;

      const writerId = writer.runtimeStageId;

      // Check if we already have a node for this writer
      let parentNode = nodeMap.get(writerId);
      if (parentNode) {
        // DAG merge: add as parent if not already linked
        if (!node.parents.some((p) => p.runtimeStageId === writerId)) {
          node.parents.push(parentNode);
        }
        continue;
      }

      // New node — create and enqueue
      if (visited >= maxNodes) continue;

      const writerIdx = idxMap.get(writerId);
      if (writerIdx === undefined) continue;

      parentNode = {
        runtimeStageId: writerId,
        stageId: writer.stageId,
        stageName: writer.stage,
        keysWritten: writer.trace.map((t) => t.path),
        linkedBy: key,
        depth: depth + 1,
        parents: [],
      };
      nodeMap.set(writerId, parentNode);
      node.parents.push(parentNode);
      visited++;

      queue.push([parentNode, writerIdx, depth + 1]);
    }
  }

  return root;
}

// ── Utilities ──────────────────────────────────────────────────────────

/**
 * Flatten the causal DAG into a BFS-ordered list of nodes.
 * Each node appears exactly once (first occurrence by BFS order).
 * Useful for linear display or iteration.
 */
export function flattenCausalDAG(root: CausalNode): CausalNode[] {
  const result: CausalNode[] = [];
  const visited = new Set<string>();
  const queue: CausalNode[] = [root];

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (visited.has(node.runtimeStageId)) continue;
    visited.add(node.runtimeStageId);
    result.push(node);

    for (const parent of node.parents) {
      if (!visited.has(parent.runtimeStageId)) {
        queue.push(parent);
      }
    }
  }

  return result;
}

/**
 * Format a causal DAG as human-readable indented text.
 * Shows the dependency chain with depth indentation and linked-by keys.
 */
export function formatCausalChain(root: CausalNode): string {
  const lines: string[] = [];
  const visited = new Set<string>();

  function walk(node: CausalNode, indent: number): void {
    if (visited.has(node.runtimeStageId)) {
      lines.push(`${'  '.repeat(indent)}↳ ${node.runtimeStageId} (see above)`);
      return;
    }
    visited.add(node.runtimeStageId);

    const link = node.linkedBy ? ` ← via ${node.linkedBy}` : '';
    const writes = node.keysWritten.length > 0 ? ` [wrote: ${node.keysWritten.join(', ')}]` : '';
    lines.push(`${'  '.repeat(indent)}${node.stageName} (${node.runtimeStageId})${link}${writes}`);

    for (const parent of node.parents) {
      walk(parent, indent + 1);
    }
  }

  walk(root, 0);
  return lines.join('\n');
}

// ── Exported for testing (internal) ────────────────────────────────────

/** @internal Exposed for testing the strategy selection. */
export const _REVERSE_INDEX_THRESHOLD = REVERSE_INDEX_THRESHOLD;
