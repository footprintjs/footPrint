/**
 * BaseState.ts
 *
 * WHY: Base class that library consumers extend to create custom scope classes.
 * Provides a consistent interface for accessing pipeline context, debug logging,
 * metrics, and state management.
 *
 * RESPONSIBILITIES:
 * - Provide debug/metric/eval logging methods
 * - Provide getValue/setValue/updateValue methods for state access
 * - Provide getInitialValueFor for accessing global context
 * - Provide getReadOnlyValues for accessing read-only context
 *
 * DESIGN DECISIONS:
 * - Uses a runtime brand (Symbol) to detect subclasses reliably
 * - Wraps StageContext to provide a consumer-friendly API
 * - Methods are intentionally simple - complex logic belongs in StageContext
 *
 * RELATED:
 * - {@link StageContext} - The underlying context this class wraps
 * - {@link Scope} - Uses BaseState subclasses for scope creation
 * - {@link guards.ts} - Uses isSubclassOfStateScope to detect BaseState subclasses
 */

import { treeConsole } from '../utils/scopeLog';
import { StageContext } from '../core/memory/StageContext';

/**
 * BaseState
 * ------------------------------------------------------------------
 * Base class that library consumers extend to create custom scope classes.
 *
 * WHY: Provides a consistent interface for accessing pipeline context,
 * debug logging, metrics, and state management. Consumers extend this
 * class to add domain-specific properties and methods.
 *
 * USAGE:
 * ```typescript
 * class MyScope extends BaseState {
 *   get userName(): string {
 *     return this.getValue('name') as string;
 *   }
 *   set userName(value: string) {
 *     this.setObject('name', value);
 *   }
 * }
 * ```
 *
 * DESIGN DECISIONS:
 * - Uses a runtime brand (Symbol) to detect subclasses reliably
 * - Protected members allow subclasses to access context directly
 * - Methods are intentionally simple - complex logic belongs in StageContext
 */
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

  getValue(key?: string) {
    return this._stageContext.getValue([], key);
  }

  setObject(key: string, value: unknown, shouldRedact?: boolean, description?: string) {
    return (this._stageContext as any).setObject([], key, value, shouldRedact, description);
  }

  updateObject(key: string, value: unknown, description?: string) {
    return this._stageContext.updateObject([], key, value, description);
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
