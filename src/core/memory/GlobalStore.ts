/**
 * GlobalStore - The shared state container for all pipeline execution
 * 
 * WHY: Pipelines need a centralized place to store and retrieve state.
 * This is the single source of truth that all stages read from and write to.
 * 
 * DESIGN: Like a compiler's symbol table or runtime heap:
 * - Namespace isolation: Each pipeline has its own namespace (pipelines/{id}/)
 * - Default values: Can be initialized with defaults that are preserved
 * - Patch application: Accepts commit bundles from WriteBuffer
 * 
 * RESPONSIBILITIES:
 * - Store and retrieve values by path
 * - Apply commit bundles from WriteBuffer
 * - Maintain namespace isolation between pipelines
 * 
 * RELATED:
 * - {@link WriteBuffer} - Produces commit bundles
 * - {@link StageContext} - Provides stage-scoped access to GlobalStore
 * 
 * @example
 * ```typescript
 * const store = new GlobalStore({ defaultConfig: {} });
 * store.setValue('pipeline-1', ['user'], 'name', 'Alice');
 * const name = store.getValue('pipeline-1', ['user'], 'name'); // 'Alice'
 * ```
 */

import cloneDeep from 'lodash.clonedeep';
import mergeWith from 'lodash.mergewith';

import { applySmartMerge, MemoryPatch } from '../../internal/memory/WriteBuffer';
import { getNestedValue, getPipelineAndGlobalPaths, setNestedValue, updateNestedValue } from '../../internal/memory/utils';

export class GlobalStore {
  private context: { [key: string]: any } = {};
  private _defaultValues?: unknown;

  constructor(defaultValues?: unknown, initialContext?: unknown) {
    this._defaultValues = defaultValues;
    // DESIGN: Merge initial context with defaults, preserving existing values
    this.context = mergeWith(
      initialContext || {},
      defaultValues || {},
      (objValue: unknown, srcValue: unknown, key: string) => {
        return typeof objValue === 'undefined' ? srcValue : objValue;
      },
    );
  }

  /**
   * Gets a clone of the default values.
   * WHY: Consumers may need defaults for initialization or reset.
   */
  getDefaultValues() {
    return this._defaultValues ? cloneDeep(this._defaultValues) : undefined;
  }

  /**
   * Gets all pipeline namespaces.
   * WHY: Enables iteration over all pipelines for debugging/visualization.
   */
  getPipelines() {
    return this.context.pipelines;
  }

  /**
   * Updates a value using merge semantics.
   * WHY: Enables additive updates without losing existing nested data.
   */
  updateValue(pipelineId: string, path: string[], key: string, value: unknown) {
    updateNestedValue(this.context, pipelineId, path, key, value, this.getDefaultValues());
  }

  /**
   * Sets a value using overwrite semantics.
   * WHY: Some operations need to completely replace a value.
   */
  setValue(pipelineId: string, path: string[], key: string, value: unknown) {
    setNestedValue(this.context, pipelineId, path, key, value, this.getDefaultValues());
  }

  /**
   * Reads a value from the store.
   * WHY: Stages need to access shared state during execution.
   * 
   * DESIGN: Looks up in pipeline namespace first, falls back to global.
   * This allows pipeline-specific overrides of global values.
   */
  getValue(pipelineId?: string, path?: string[], key?: string): any {
    const { globalPath, pipelinePath } = getPipelineAndGlobalPaths(pipelineId, path);
    const value = pipelinePath ? getNestedValue(this.context, pipelinePath, key) : undefined;
    return typeof value !== 'undefined' ? value : getNestedValue(this.context, globalPath, key);
  }

  /**
   * Gets the entire state as a JSON object.
   * WHY: Enables serialization for persistence or debugging.
   */
  getState(): Record<string, unknown> {
    return this.context;
  }

  /**
   * Applies a commit bundle from WriteBuffer.
   * WHY: Stages commit their mutations through WriteBuffer, which produces
   * patches that need to be applied to the global state.
   */
  applyPatch(overwrite: MemoryPatch, updates: MemoryPatch, trace: { path: string; verb: 'set' | 'merge' }[]): void {
    this.context = applySmartMerge(this.context, updates, overwrite, trace);
  }
}
