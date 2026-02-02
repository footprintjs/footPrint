/**
 * baseStateCompatible.ts
 *
 * WHY: Attaches BaseState-like methods onto any target object (e.g., a proxy scope).
 * This allows non-class scopes (like Zod-generated scopes) to have the same
 * convenience methods as BaseState subclasses.
 *
 * RESPONSIBILITIES:
 * - Attach debug/metric/eval logging methods
 * - Attach getValue/setValue/updateValue methods
 * - Attach getInitialValueFor, getReadOnlyValues, getPipelineId methods
 *
 * DESIGN DECISIONS:
 * - Uses Object.assign to add methods to existing objects
 * - Methods delegate to StageContextLike for actual implementation
 * - Allows any object to gain BaseState-like capabilities
 *
 * RELATED:
 * - {@link BaseState} - The class these methods are modeled after
 * - {@link types.ts} - StageContextLike interface
 */

import { StageContextLike } from './types';

/** Attach BaseState-like methods onto any target (e.g., a proxy scope) */
export function attachBaseStateCompat<T extends object>(
  target: T,
  ctx: StageContextLike,
  stageName: string,
  readOnly?: unknown,
): T & {
  addDebugInfo(k: string, v: unknown): void;
  addDebugMessage(v: unknown): void;
  addErrorInfo(k: string, v: unknown): void;
  addMetric(name: string, v: unknown): void;
  addEval(name: string, v: unknown): void;

  getInitialValueFor(k: string): unknown;
  getValue(path: string[], key?: string): unknown;
  setObject(path: string[], key: string, value: unknown, shouldRedact?: boolean, description?: string): void;
  updateObject(path: string[], key: string, value: unknown, description?: string): void;
  setObjectInRoot(key: string, value: unknown): void;

  getReadOnlyValues(): unknown;
  getPipelineId(): string | undefined;
} {
  const compat = {
    addDebugInfo: (k: string, v: unknown) => ctx.addLog?.(k, v),
    addDebugMessage: (v: unknown) => ctx.addLog?.('messages', [v]),
    addErrorInfo: (k: string, v: unknown) => ctx.addError?.(k, v),
    addMetric: (name: string, v: unknown) => ctx.addLog?.(`metric:${name}`, v),
    addEval: (name: string, v: unknown) => ctx.addLog?.(`eval:${name}`, v),

    getInitialValueFor: (k: string) => ctx.getFromGlobalContext?.(k),
    getValue: (path: string[], key?: string) => ctx.getValue(path, key),
    setObject: (path: string[], key: string, value: unknown, shouldRedact = false, description?: string) =>
      (ctx as any).setObject(path, key, value, shouldRedact, description),
    updateObject: (path: string[], key: string, value: unknown, description?: string) =>
      ctx.updateObject(path, key, value, description),
    setObjectInRoot: (key: string, value: unknown) => ctx.setRoot?.(key, value),

    getReadOnlyValues: () => readOnly,
    getPipelineId: () => ctx.pipelineId,
  };

  return Object.assign(target, compat);
}
