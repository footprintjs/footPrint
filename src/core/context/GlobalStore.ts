/**
 * GlobalStore - The shared state container for all pipeline execution
 * ----------------------------------------------------------------------------
 *  The single source of truth for pipeline state. All stages read from and
 *  write to this store (via WriteBuffer commits).
 *
 *  Think of it like a compiler's symbol table or a runtime's heap - it holds
 *  all the data that stages need to access and modify during execution.
 *
 *  Key features:
 *    - Namespace isolation: Each pipeline has its own namespace
 *    - Default values: Can be initialized with defaults that are preserved
 *    - Patch application: Accepts commit bundles from WriteBuffer
 */

import cloneDeep from 'lodash.clonedeep';
import mergeWith from 'lodash.mergewith';

import { applySmartMerge, MemoryPatch } from '../stateManagement/WriteBuffer';
import { getNestedValue, getPipelineAndGlobalPaths, setNestedValue, updateNestedValue } from '../stateManagement/utils';

/**
 * GlobalStore - Centralized state container for pipeline execution
 * 
 * Manages the shared state that all stages can read from and write to.
 * Supports namespaced access per pipeline and global values.
 */
export class GlobalStore {
  private context: { [key: string]: any } = {};

  private _defaultValues?: unknown;

  constructor(defaultValues?: unknown, initialContext?: unknown) {
    this._defaultValues = defaultValues;
    this.context = mergeWith(
      initialContext || {},
      defaultValues || {},
      (objValue: unknown, srcValue: unknown, key: string) => {
        return typeof objValue === 'undefined' ? srcValue : objValue;
      },
    );
  }

  /**
   * getDefaultValues() - Get a clone of the default values
   */
  getDefaultValues() {
    return this._defaultValues ? cloneDeep(this._defaultValues) : undefined;
  }

  /**
   * getPipelines() - Get all pipeline namespaces
   */
  getPipelines() {
    return this.context.pipelines;
  }

  /**
   * updateValue() - Update a value using merge semantics
   */
  updateValue(pipelineId: string, path: string[], key: string, value: unknown) {
    updateNestedValue(this.context, pipelineId, path, key, value, this.getDefaultValues());
  }

  /**
   * setValue() - Set a value using overwrite semantics
   */
  setValue(pipelineId: string, path: string[], key: string, value: unknown) {
    setNestedValue(this.context, pipelineId, path, key, value, this.getDefaultValues());
  }

  /**
   * getValue() - Read a value from the store
   * 
   * Looks up in pipeline namespace first, falls back to global namespace.
   */
  getValue(pipelineId?: string, path?: string[], key?: string): any {
    const { globalPath, pipelinePath } = getPipelineAndGlobalPaths(pipelineId, path);
    const value = pipelinePath ? getNestedValue(this.context, pipelinePath, key) : undefined;
    return typeof value !== 'undefined' ? value : getNestedValue(this.context, globalPath, key);
  }

  /**
   * getState() - Get the entire state as a JSON object
   * 
   * Returns the raw context object for serialization or inspection.
   */
  getState(): Record<string, unknown> {
    return this.context;
  }

  /**
   * @deprecated Use getState() instead
   */
  getJson(): Record<string, unknown> {
    return this.getState();
  }

  /**
   * applyPatch() - Apply a commit bundle from WriteBuffer
   * 
   * Merges the staged mutations into the global state.
   */
  applyPatch(overwrite: MemoryPatch, updates: MemoryPatch, trace: { path: string; verb: 'set' | 'merge' }[]): void {
    this.context = applySmartMerge(this.context, updates, overwrite, trace);
  }
}

// Legacy alias for backward compatibility during migration
export { GlobalStore as GlobalContext };
