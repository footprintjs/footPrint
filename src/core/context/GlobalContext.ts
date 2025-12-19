import cloneDeep from 'lodash.clonedeep';
import mergeWith from 'lodash.mergewith';

import { applySmartMerge, MemoryPatch } from '../stateManagement/PatchedMemoryContext';
import { getNestedValue, getPipelineAndGlobalPaths, setNestedValue, updateNestedValue } from '../stateManagement/utils';

export class GlobalContext {
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

  getDefaultValues() {
    return this._defaultValues ? cloneDeep(this._defaultValues) : undefined;
  }

  getPipelines() {
    return this.context.pipelines;
  }

  // Write: Update
  updateValue(pipelineId: string, path: string[], key: string, value: unknown) {
    updateNestedValue(this.context, pipelineId, path, key, value, this.getDefaultValues());
  }

  // Write: Create
  setValue(pipelineId: string, path: string[], key: string, value: unknown) {
    setNestedValue(this.context, pipelineId, path, key, value, this.getDefaultValues());
  }

  // Read: getter
  getValue(pipelineId?: string, path?: string[], key?: string): any {
    const { globalPath, pipelinePath } = getPipelineAndGlobalPaths(pipelineId, path);
    const value = pipelinePath ? getNestedValue(this.context, pipelinePath, key) : undefined;
    return typeof value !== 'undefined' ? value : getNestedValue(this.context, globalPath, key);
  }

  getJson(): Record<string, unknown> {
    return this.context;
  }

  applyPatch(overwrite: MemoryPatch, updates: MemoryPatch, trace: { path: string; verb: 'set' | 'merge' }[]): void {
    this.context = applySmartMerge(this.context, updates, overwrite, trace);
  }
}
