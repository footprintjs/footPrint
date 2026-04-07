/**
 * EventLog — Time-travel snapshot storage for flowchart execution
 *
 * Like git history: stores commit bundles (diffs), not full snapshots.
 * materialise(stepIdx) reconstructs state at any point by replaying commits.
 */
import type { CommitBundle } from './types.js';
export declare class EventLog {
    /** Base snapshot BEFORE the first stage mutates anything. */
    private base;
    /** Ordered list of commit bundles. */
    private steps;
    constructor(initialMemory: any);
    /**
     * Reconstructs the full state at any given step.
     * Replays commits from the beginning — O(n) but low memory footprint.
     */
    materialise(stepIdx?: number): any;
    /** Persists a commit bundle for a finished stage. */
    record(bundle: CommitBundle): void;
    /** Gets all recorded commit bundles. */
    list(): CommitBundle[];
    /** Number of recorded commits. */
    get length(): number;
    /** Wipes history (useful for test resets). */
    clear(): void;
}
