import type { ValueFact } from '../observation.js';
export interface FixtureEdit {
  readonly outcome: 'returned' | 'threw';
  readonly start: number;
  readonly end: number;
  readonly object?: number;
  readonly n: number;
  readonly before: ValueFact;
  readonly after: ValueFact;
}
export interface NativePort {
  /** The SAME observer's clock, raw-object WeakMap and immediate detached snapshotter. */
  tick(): number;
  objectId(value: object): number;
  snapshot(value: unknown): ValueFact;
}
export interface OperationStamp {
  readonly coordinate: readonly (string | number)[];
  readonly programPath: readonly (string | number)[];
  readonly path?: readonly string[];
}
export interface OperationSpan extends OperationStamp {
  readonly start: number;
  readonly end: number;
  readonly edits: readonly FixtureEdit[];
  readonly outcome: 'returned' | 'threw';
}
/** Capture failures poison evidence; they never replace a fixture result or escaping value. */
export function createOperationPort(native: NativePort) {
  let active: (OperationStamp & { start: number; edits: FixtureEdit[] }) | undefined;
  const spans: OperationSpan[] = [];
  const issues: string[] = [];
  const capture = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch {
      issues.push('unsupported fixture observation');
      return undefined;
    }
  };
  return {
    /** Native wrappers read this label as metadata; this is never a StageContext or authority. */
    current: () =>
      active &&
      Object.freeze({
        coordinate: active.coordinate,
        programPath: active.programPath,
        path: active.path,
        start: active.start,
      }),
    within<T>(stamp: OperationStamp, runUnchanged: () => T): T {
      if (active) issues.push('overlapping fixture operation');
      const parent = active;
      active = {
        coordinate: Object.freeze([...stamp.coordinate]),
        programPath: Object.freeze([...stamp.programPath]),
        ...(stamp.path !== undefined && { path: Object.freeze([...stamp.path]) }),
        start: native.tick(),
        edits: [],
      };
      let outcome: 'returned' | 'threw' = 'returned';
      try {
        return runUnchanged();
      } catch (error) {
        outcome = 'threw';
        throw error;
      } finally {
        spans.push(Object.freeze({ ...active, edits: Object.freeze([...active.edits]), end: native.tick(), outcome }));
        active = parent;
      }
    },
    /** Wrap the EXISTING edit helper call once. No alternate implementation executes on a native value. */
    edit(value: unknown, n: number, original: (value: unknown, n: number) => void): void {
      const owner = active;
      const start = native.tick();
      const object = value !== null && typeof value === 'object' ? capture(() => native.objectId(value)) : undefined;
      const before = capture(() => native.snapshot(value));
      let outcome: 'returned' | 'threw' = 'returned';
      try {
        original(value, n);
      } catch (error) {
        outcome = 'threw';
        throw error;
      } finally {
        const after = capture(() => native.snapshot(value));
        const end = native.tick();
        if (owner && before && after)
          owner.edits.push(
            Object.freeze({
              start,
              end,
              object,
              before,
              after,
              n,
              outcome,
            }),
          );
        else if (owner) issues.push('unjoined edit observation');
      }
    },
    receipt: () => ({ spans: Object.freeze([...spans]), issues: Object.freeze([...issues]) }),
  };
}
export type FixtureOperations = Pick<ReturnType<typeof createOperationPort>, 'within' | 'edit'>;
