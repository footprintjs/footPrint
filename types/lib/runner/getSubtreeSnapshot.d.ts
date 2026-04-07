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
import type { CombinedNarrativeEntry } from '../engine/narrative/narrativeTypes.js';
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
export declare function getSubtreeSnapshot(snapshot: RuntimeSnapshot, path: string, allNarrativeEntries?: CombinedNarrativeEntry[]): SubtreeSnapshot | undefined;
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
export declare function listSubflowPaths(snapshot: RuntimeSnapshot): string[];
