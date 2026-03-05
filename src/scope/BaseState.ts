/**
 * BaseState.ts
 *
 * WHY: Base class that library consumers extend to create custom scope classes.
 * Provides a consistent interface for accessing pipeline context, debug logging,
 * metrics, state management, and optional recorder support.
 *
 * RESPONSIBILITIES:
 * - Provide debug/metric/eval logging methods
 * - Provide getValue/setValue/updateValue methods for state access
 * - Provide getInitialValueFor for accessing global context
 * - Provide getReadOnlyValues for accessing read-only context
 * - Bridge Recorder hooks to the real StageContext execution path
 *
 * DESIGN DECISIONS:
 * - Uses a runtime brand (Symbol) to detect subclasses reliably
 * - Wraps StageContext to provide a consumer-friendly API
 * - Methods are intentionally simple - complex logic belongs in StageContext
 * - Recorder support is opt-in: attach recorders to observe read/write/commit operations
 *
 * RELATED:
 * - {@link StageContext} - The underlying context this class wraps
 * - {@link Recorder} - Pluggable observer interface for scope operations
 * - {@link guards.ts} - Uses isSubclassOfStateScope to detect BaseState subclasses
 */

import { treeConsole } from '../utils/scopeLog';
import { StageContext } from '../core/memory/StageContext';
import type { Recorder, ReadEvent, WriteEvent, CommitEvent, ErrorEvent, StageEvent } from './types';

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
 *     this.setValue('name', value);
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

  /** Recorders attached to this BaseState instance */
  private _recorders: Recorder[] = [];

  constructor(context: StageContext, stageName: string, readOnlyValues?: unknown) {
    this._stageContext = context;
    this._stageName = stageName;
    this._readOnlyValues = readOnlyValues;
  }

  // ---------------- Recorder Management

  /**
   * Attaches a recorder to observe read/write/commit operations on this scope.
   * Recorders are invoked in attachment order.
   */
  attachRecorder(recorder: Recorder): void {
    this._recorders.push(recorder);
  }

  /**
   * Detaches a recorder by its ID. No-op if not found.
   */
  detachRecorder(recorderId: string): void {
    this._recorders = this._recorders.filter((r) => r.id !== recorderId);
  }

  /**
   * Returns a copy of all attached recorders.
   */
  getRecorders(): Recorder[] {
    return [...this._recorders];
  }

  /**
   * Signals the start of stage execution. Invokes onStageStart on all recorders.
   */
  notifyStageStart(): void {
    this._invokeHook('onStageStart', {
      stageName: this._stageName,
      pipelineId: this._stageContext.pipelineId,
      timestamp: Date.now(),
    });
  }

  /**
   * Signals the end of stage execution. Invokes onStageEnd on all recorders.
   */
  notifyStageEnd(duration?: number): void {
    this._invokeHook('onStageEnd', {
      stageName: this._stageName,
      pipelineId: this._stageContext.pipelineId,
      timestamp: Date.now(),
      duration,
    });
  }

  /**
   * Signals that staged writes have been committed.
   * Called by the pipeline after context.commit().
   */
  notifyCommit(mutations: CommitEvent['mutations']): void {
    this._invokeHook('onCommit', {
      stageName: this._stageName,
      pipelineId: this._stageContext.pipelineId,
      timestamp: Date.now(),
      mutations,
    });
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
    return this._stageContext.getFromGlobalContext?.(key);
  }

  getValue(key?: string) {
    const value = this._stageContext.getValue([], key);

    if (this._recorders.length > 0) {
      this._invokeHook('onRead', {
        stageName: this._stageName,
        pipelineId: this._stageContext.pipelineId,
        timestamp: Date.now(),
        key,
        value,
      });
    }

    return value;
  }

  setValue(key: string, value: unknown, shouldRedact?: boolean, description?: string) {
    const result = this._stageContext.setObject([], key, value, shouldRedact, description);

    if (this._recorders.length > 0) {
      this._invokeHook('onWrite', {
        stageName: this._stageName,
        pipelineId: this._stageContext.pipelineId,
        timestamp: Date.now(),
        key,
        value,
        operation: 'set',
      });
    }

    return result;
  }

  updateValue(key: string, value: unknown, description?: string) {
    const result = this._stageContext.updateObject([], key, value, description);

    if (this._recorders.length > 0) {
      this._invokeHook('onWrite', {
        stageName: this._stageName,
        pipelineId: this._stageContext.pipelineId,
        timestamp: Date.now(),
        key,
        value,
        operation: 'update',
      });
    }

    return result;
  }

  deleteValue(key: string, description?: string) {
    const result = this._stageContext.setObject([], key, undefined, false, description ?? `deleted ${key}`);

    if (this._recorders.length > 0) {
      this._invokeHook('onWrite', {
        stageName: this._stageName,
        pipelineId: this._stageContext.pipelineId,
        timestamp: Date.now(),
        key,
        value: undefined,
        operation: 'delete',
      });
    }

    return result;
  }

  setGlobal(key: string, value: unknown, description?: string) {
    return this._stageContext.setGlobal?.(key, value, description);
  }

  getGlobal(key: string) {
    return this._stageContext.getGlobal?.(key);
  }

  setObjectInRoot(key: string, value: unknown) {
    return this._stageContext.setRoot?.(key, value);
  }

  // ---------------- read-only + misc
  getReadOnlyValues() {
    return this._readOnlyValues;
  }

  getPipelineId() {
    return this._stageContext.pipelineId;
  }

  // ---------------- Internal recorder hook invocation

  /**
   * Invokes a hook on all attached recorders with fail-safe error handling.
   * Recorder errors are caught and forwarded to onError hooks (avoiding infinite recursion).
   */
  private _invokeHook(hook: keyof Omit<Recorder, 'id'>, event: unknown): void {
    for (const recorder of this._recorders) {
      try {
        const hookFn = recorder[hook];
        if (typeof hookFn === 'function') {
          (hookFn as (event: unknown) => void).call(recorder, event);
        }
      } catch (error) {
        if (hook !== 'onError') {
          this._invokeHook('onError', {
            stageName: this._stageName,
            pipelineId: this._stageContext.pipelineId,
            timestamp: Date.now(),
            error: error as Error,
            operation: hook === 'onRead' ? 'read' : hook === 'onCommit' ? 'commit' : 'write',
          });
        }
      }
    }
  }
}
