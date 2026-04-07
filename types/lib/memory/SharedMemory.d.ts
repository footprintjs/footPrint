/**
 * SharedMemory — The shared state container for all flowchart execution
 *
 * Like a runtime heap with namespace isolation:
 * - Each run gets its own namespace (runs/{id}/)
 * - Default values can be initialised and preserved
 * - Accepts commit bundles from TransactionBuffer
 */
import type { MemoryPatch } from './types.js';
export declare class SharedMemory {
    private context;
    private _defaultValues?;
    constructor(defaultValues?: unknown, initialContext?: unknown);
    /** Gets a clone of the default values. */
    getDefaultValues(): {} | undefined;
    /** Gets all run namespaces. */
    getRuns(): any;
    /** Updates a value using merge semantics. */
    updateValue(runId: string, path: string[], key: string, value: unknown): void;
    /** Sets a value using overwrite semantics. */
    setValue(runId: string, path: string[], key: string, value: unknown): void;
    /**
     * Reads a value from the store.
     * Looks up in run namespace first, falls back to global.
     */
    getValue(runId?: string, path?: string[], key?: string): any;
    /** Gets the entire state as a JSON object. */
    getState(): Record<string, unknown>;
    /** Applies a commit bundle from TransactionBuffer. */
    applyPatch(overwrite: MemoryPatch, updates: MemoryPatch, trace: {
        path: string;
        verb: 'set' | 'merge';
    }[]): void;
}
