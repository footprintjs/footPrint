/**
 * ScopeFacade — Base class that library consumers extend to create custom scope classes
 *
 * Wraps StageContext (from memory/) to provide a consumer-friendly API for
 * state access, debug logging, metrics, and recorder hooks.
 *
 * Consumers extend this class to add domain-specific properties:
 *
 * ```typescript
 * class MyScope extends ScopeFacade {
 *   get userName(): string { return this.getValue('name') as string; }
 *   set userName(value: string) { this.setValue('name', value); }
 * }
 * ```
 */

import { StageContext } from '../memory/StageContext';
import type { Recorder, CommitEvent } from './types';

export class ScopeFacade {
  public static readonly BRAND = Symbol.for('ScopeFacade@v1');

  protected _stageContext: StageContext;
  protected _stageName: string;
  protected readonly _readOnlyValues?: unknown;

  private _recorders: Recorder[] = [];

  constructor(context: StageContext, stageName: string, readOnlyValues?: unknown) {
    this._stageContext = context;
    this._stageName = stageName;
    this._readOnlyValues = readOnlyValues;
  }

  // ── Recorder Management ──────────────────────────────────────────────────

  attachRecorder(recorder: Recorder): void {
    this._recorders.push(recorder);
  }

  detachRecorder(recorderId: string): void {
    this._recorders = this._recorders.filter((r) => r.id !== recorderId);
  }

  getRecorders(): Recorder[] {
    return [...this._recorders];
  }

  notifyStageStart(): void {
    this._invokeHook('onStageStart', {
      stageName: this._stageName,
      pipelineId: this._stageContext.runId,
      timestamp: Date.now(),
    });
  }

  notifyStageEnd(duration?: number): void {
    this._invokeHook('onStageEnd', {
      stageName: this._stageName,
      pipelineId: this._stageContext.runId,
      timestamp: Date.now(),
      duration,
    });
  }

  notifyCommit(mutations: CommitEvent['mutations']): void {
    this._invokeHook('onCommit', {
      stageName: this._stageName,
      pipelineId: this._stageContext.runId,
      timestamp: Date.now(),
      mutations,
    });
  }

  // ── Debug / Diagnostics ──────────────────────────────────────────────────

  addDebugInfo(key: string, value: unknown) {
    this._stageContext.addLog(key, value);
  }

  addDebugMessage(value: unknown) {
    this._stageContext.addLog('messages', [value]);
  }

  addErrorInfo(key: string, value: unknown) {
    this._stageContext.addError(key, value);
  }

  addMetric(metricName: string, value: unknown) {
    this._stageContext.addMetric(metricName, value);
  }

  addEval(metricName: string, value: unknown) {
    this._stageContext.addEval(metricName, value);
  }

  // ── State Access ─────────────────────────────────────────────────────────

  getInitialValueFor(key: string) {
    return this._stageContext.getFromGlobalContext?.(key);
  }

  getValue(key?: string) {
    const value = this._stageContext.getValue([], key);

    if (this._recorders.length > 0) {
      this._invokeHook('onRead', {
        stageName: this._stageName,
        pipelineId: this._stageContext.runId,
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
        pipelineId: this._stageContext.runId,
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
        pipelineId: this._stageContext.runId,
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
        pipelineId: this._stageContext.runId,
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

  // ── Read-only + misc ─────────────────────────────────────────────────────

  getReadOnlyValues() {
    return this._readOnlyValues;
  }

  getPipelineId() {
    return this._stageContext.runId;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

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
            pipelineId: this._stageContext.runId,
            timestamp: Date.now(),
            error: error as Error,
            operation: hook === 'onRead' ? 'read' : hook === 'onCommit' ? 'commit' : 'write',
          });
        }
      }
    }
  }
}
