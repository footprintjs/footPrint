/**
 * TransactionBuffer — Transactional write buffer for stage mutations
 *
 * Collects writes during execution and commits them atomically.
 * Like a database transaction buffer:
 * - Changes staged here before being committed to SharedMemory
 * - Enables read-after-write consistency within a stage
 * - Records operation trace for deterministic replay
 */
import type { MemoryPatch } from './types.js';
export declare class TransactionBuffer {
    private readonly baseSnapshot;
    private workingCopy;
    private overwritePatch;
    private updatePatch;
    private opTrace;
    private redactedPaths;
    constructor(base: any);
    /** Hard overwrite at the specified path. */
    set(path: (string | number)[], value: any, shouldRedact?: boolean): void;
    /** Deep union merge at the specified path. */
    merge(path: (string | number)[], value: any, shouldRedact?: boolean): void;
    /** Read current value at path (includes uncommitted changes). */
    get(path: (string | number)[], defaultValue?: any): any;
    /**
     * Flush all staged mutations and return the commit bundle.
     * Resets the buffer to empty state after commit.
     */
    commit(): {
        overwrite: MemoryPatch;
        updates: MemoryPatch;
        redactedPaths: Set<string>;
        trace: {
            path: string;
            verb: 'set' | 'merge';
        }[];
    };
}
