/**
 * getSubtreeSnapshot — navigate an execution snapshot tree by subflow path.
 *
 * Given a RuntimeSnapshot and a slash-separated path of subflow IDs,
 * returns the subtree rooted at that subflow. Useful for LLM drill-down:
 * instead of dumping the full trace, fetch only the relevant subtree.
 *
 * Usage:
 *   const snapshot = executor.getSnapshot();
 *
 *   // Top-level subflow
 *   getSubtreeSnapshot(snapshot, 'sf-payment');
 *
 *   // Nested subflow (payment → validation)
 *   getSubtreeSnapshot(snapshot, 'sf-payment/sf-validation');
 *
 *   // Returns undefined if path not found
 *   getSubtreeSnapshot(snapshot, 'nonexistent'); // undefined
 *
 *   // Discover available paths
 *   listSubflowPaths(snapshot); // ['sf-payment', 'sf-payment/sf-validation']
 */

import type { CombinedNarrativeEntry } from '../engine/narrative/CombinedNarrativeBuilder.js';
import type { StageSnapshot } from '../memory/types.js';
import type { RuntimeSnapshot } from './ExecutionRuntime.js';

/** The result of navigating to a subtree within a snapshot. */
export interface SubtreeSnapshot {
  /** The subflow ID that was matched (last segment of the path). */
  readonly subflowId: string;
  /** The execution tree rooted at this subflow. */
  readonly executionTree: StageSnapshot;
  /** Shared state scoped to this subflow (from subflowResults if available). */
  readonly sharedState?: Record<string, unknown>;
  /** Narrative entries scoped to this subflow (between entry/exit events). */
  readonly narrativeEntries?: CombinedNarrativeEntry[];
}

/**
 * Navigate the execution snapshot tree by a slash-separated subflow path.
 *
 * **Implementation note:** footprintjs's SubflowExecutor stores nested subflow
 * results with composite slash-separated keys (e.g. "sf-outer/sf-inner") in
 * the flat `subflowResults` map. This function uses those keys for lookup.
 *
 * @param snapshot — the full RuntimeSnapshot from `executor.getSnapshot()`
 * @param path — slash-separated subflow IDs, e.g. `"sf-payment"` or `"sf-payment/sf-validation"`
 * @param allNarrativeEntries — optional full narrative entries from `executor.getNarrativeEntries()`, used to extract scoped narrative for the subtree
 * @returns the matching SubtreeSnapshot, or `undefined` if the path is not found
 */
export function getSubtreeSnapshot(
  snapshot: RuntimeSnapshot,
  path: string,
  allNarrativeEntries?: CombinedNarrativeEntry[],
): SubtreeSnapshot | undefined {
  if (!snapshot || !path) return undefined;

  const normalizedPath = path.split('/').filter(Boolean).join('/');
  if (!normalizedPath) return undefined;

  const subflowResults = snapshot.subflowResults;
  const lastSegment = normalizedPath.split('/').pop()!;

  // Strategy 1: Direct lookup in subflowResults by full path.
  // SubflowExecutor stores nested results with composite slash-separated keys.
  if (subflowResults && subflowResults[normalizedPath]) {
    const sfResult = subflowResults[normalizedPath] as Record<string, unknown>;
    const treeCtx = sfResult.treeContext as Record<string, unknown> | undefined;

    return {
      subflowId: lastSegment,
      executionTree:
        (treeCtx?.stageContexts as unknown as StageSnapshot) ?? findSubflowInTree(snapshot.executionTree, lastSegment),
      sharedState: treeCtx?.globalContext as Record<string, unknown> | undefined,
      narrativeEntries: allNarrativeEntries
        ? extractScopedNarrative(allNarrativeEntries, (sfResult.subflowName as string | undefined) ?? lastSegment)
        : undefined,
    };
  }

  // Strategy 2: Find the node in the execution tree by subflowId
  const foundNode = findSubflowInTree(snapshot.executionTree, lastSegment);
  if (!foundNode) return undefined;

  return {
    subflowId: lastSegment,
    executionTree: foundNode,
    sharedState: undefined,
    narrativeEntries: allNarrativeEntries ? extractScopedNarrative(allNarrativeEntries, lastSegment) : undefined,
  };
}

/**
 * List all available subflow paths in a snapshot.
 *
 * Returns the keys from `subflowResults`, which are slash-separated
 * subflow ID paths (e.g. `["sf-payment", "sf-outer/sf-inner"]`).
 * Useful for discovery — an LLM or UI can enumerate available drill-down targets.
 *
 * @param snapshot — the full RuntimeSnapshot from `executor.getSnapshot()`
 * @returns array of available subflow paths, empty if none
 */
export function listSubflowPaths(snapshot: RuntimeSnapshot): string[] {
  if (!snapshot?.subflowResults) return [];
  return Object.keys(snapshot.subflowResults);
}

/**
 * Extract narrative entries scoped to a specific subflow.
 * Finds entries between the subflow's entry and exit events.
 */
function extractScopedNarrative(entries: CombinedNarrativeEntry[], subflowName: string): CombinedNarrativeEntry[] {
  const scoped: CombinedNarrativeEntry[] = [];
  let inside = false;

  for (const entry of entries) {
    if (entry.type === 'subflow' && entry.text.includes(subflowName)) {
      if (entry.text.toLowerCase().includes('entering')) {
        inside = true;
        scoped.push(entry);
        continue;
      }
      if (entry.text.toLowerCase().includes('exiting')) {
        scoped.push(entry);
        inside = false;
        continue;
      }
    }
    if (inside) {
      scoped.push(entry);
    }
  }

  return scoped;
}

/**
 * Find a subflow node in the execution tree by searching for a node
 * whose subflowId matches.
 * Searches depth-first through `next` and `children` links.
 */
function findSubflowInTree(node: StageSnapshot | undefined, subflowId: string): StageSnapshot | undefined {
  if (!node) return undefined;

  if (node.subflowId === subflowId) return node;

  if (node.children) {
    for (const child of node.children) {
      const found = findSubflowInTree(child, subflowId);
      if (found) return found;
    }
  }

  if (node.next) {
    return findSubflowInTree(node.next, subflowId);
  }

  return undefined;
}
