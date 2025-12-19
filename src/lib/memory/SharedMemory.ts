/**
 * SharedMemory — The shared state container for all flowchart execution
 *
 * Like a runtime heap with namespace isolation:
 * - Each run gets its own namespace (runs/{id}/)
 * - Default values can be initialised and preserved
 * - Accepts commit bundles from TransactionBuffer
 */

import mergeWith from 'lodash.mergewith';

import type { MemoryPatch } from './types';
import { applySmartMerge, getNestedValue, getRunAndGlobalPaths, setNestedValue, updateNestedValue } from './utils';

export class SharedMemory {
  private context: { [key: string]: any } = {};
  private _defaultValues?: unknown;

  constructor(defaultValues?: unknown, initialContext?: unknown) {
    this._defaultValues = defaultValues;
    this.context = mergeWith(
      initialContext || {},
      defaultValues || {},
      (objValue: unknown) => {
        return typeof objValue === 'undefined' ? undefined : objValue;
      },
    );
  }

  /** Gets a clone of the default values. */
  getDefaultValues() {
    return this._defaultValues ? structuredClone(this._defaultValues) : undefined;
  }

  /** Gets all run namespaces. */
  getRuns() {
    return this.context.runs;
  }

  /** Updates a value using merge semantics. */
  updateValue(runId: string, path: string[], key: string, value: unknown) {
    updateNestedValue(this.context, runId, path, key, value, this.getDefaultValues());
  }

  /** Sets a value using overwrite semantics. */
  setValue(runId: string, path: string[], key: string, value: unknown) {
    setNestedValue(this.context, runId, path, key, value, this.getDefaultValues());
  }

  /**
   * Reads a value from the store.
   * Looks up in run namespace first, falls back to global.
   */
  getValue(runId?: string, path?: string[], key?: string): any {
    const { globalPath, runPath } = getRunAndGlobalPaths(runId, path);
    const value = runPath ? getNestedValue(this.context, runPath, key) : undefined;
    return typeof value !== 'undefined' ? value : getNestedValue(this.context, globalPath, key);
  }

  /** Gets the entire state as a JSON object. */
  getState(): Record<string, unknown> {
    return this.context;
  }

  /** Applies a commit bundle from TransactionBuffer. */
  applyPatch(overwrite: MemoryPatch, updates: MemoryPatch, trace: { path: string; verb: 'set' | 'merge' }[]): void {
    this.context = applySmartMerge(this.context, updates, overwrite, trace);
  }
}
