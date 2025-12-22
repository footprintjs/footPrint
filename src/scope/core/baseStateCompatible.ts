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
  setObject(path: string[], key: string, value: unknown, shouldRedact?: boolean): void;
  updateObject(path: string[], key: string, value: unknown): void;
  setObjectInRoot(key: string, value: unknown): void;

  getReadOnlyValues(): unknown;
  getPipelineId(): string | undefined;
} {
  const compat = {
    addDebugInfo: (k: string, v: unknown) => ctx.addDebugInfo?.(k, v),
    addDebugMessage: (v: unknown) => ctx.addDebugInfo?.('messages', [v]),
    addErrorInfo: (k: string, v: unknown) => ctx.addErrorInfo?.(k, v),
    addMetric: (name: string, v: unknown) => ctx.addDebugInfo?.(`metric:${name}`, v),
    addEval: (name: string, v: unknown) => ctx.addDebugInfo?.(`eval:${name}`, v),

    getInitialValueFor: (k: string) => ctx.getFromGlobalContext?.(k),
    getValue: (path: string[], key?: string) => ctx.getValue(path, key),
    setObject: (path: string[], key: string, value: unknown, shouldRedact = false) =>
      (ctx as any).setObject(path, key, value, shouldRedact),
    updateObject: (path: string[], key: string, value: unknown) => ctx.updateObject(path, key, value),
    setObjectInRoot: (key: string, value: unknown) => ctx.setRoot?.(key, value),

    getReadOnlyValues: () => readOnly,
    getPipelineId: () => ctx.pipelineId,
  };

  return Object.assign(target, compat);
}
