import { treeConsole } from '../../core/context/scopeLog';
import { StageContext } from '../../core/context/StageContext';

/** Base class that library consumers extend */
export class BaseState {
  // runtime brand to detect subclasses reliably
  public static readonly BRAND = Symbol.for('BaseState@v1');

  protected _stageContext: StageContext;
  protected _stageName: string;
  protected readonly _readOnlyValues?: unknown;

  constructor(context: StageContext, stageName: string, readOnlyValues?: unknown) {
    this._stageContext = context;
    this._stageName = stageName;
    this._readOnlyValues = readOnlyValues;
  }

  // ---------------- Debug (not included in final context)
  addDebugInfo(key: string, value: unknown) {
    treeConsole.log(this._stageContext, this._stageName, [], key, value);
  }

  addDebugMessage(value: unknown) {
    treeConsole.log(this._stageContext, this._stageName, [], 'messages', [value]);
  }

  addErrorInfo(key: string, value: unknown) {
    treeConsole.log(this._stageContext, this._stageName, [], key, [value]);
  }

  addMetric(metricName: string, value: unknown) {
    treeConsole.metric(this._stageContext, this._stageName, [], metricName, value);
  }

  addEval(metricName: string, value: unknown) {
    treeConsole.eval(this._stageContext, this._stageName, [], metricName, value);
  }

  // ---------------- getters / setters
  getInitialValueFor(key: string) {
    return (this._stageContext as any).getFromGlobalContext?.(key);
  }

  getValue(path: string[], key?: string) {
    return this._stageContext.getValue(path, key);
  }

  setObject(path: string[], key: string, value: unknown, shouldRedact?: boolean, description?: string) {
    return (this._stageContext as any).setObject(path, key, value, shouldRedact, description);
  }

  updateObject(path: string[], key: string, value: unknown, description?: string) {
    return this._stageContext.updateObject(path, key, value, description);
  }

  setGlobal(key: string, value: unknown, description?: string) {
    return (this._stageContext as any).setGlobal?.(key, value, description);
  }

  getGlobal(key: string) {
    return (this._stageContext as any).getGlobal?.(key);
  }

  setObjectInRoot(key: string, value: unknown) {
    return (this._stageContext as any).setRoot?.(key, value);
  }

  // ---------------- read-only + misc
  getReadOnlyValues() {
    return this._readOnlyValues;
  }

  getPipelineId() {
    return (this._stageContext as any).pipelineId;
  }
}
