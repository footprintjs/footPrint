/**
 * reactive/types -- Type definitions for the TypedScope<T> reactive proxy system.
 *
 * TypedScope<T> wraps a ReactiveTarget (ScopeFacade) in a Proxy that provides
 * typed property access. All scope infrastructure methods are $-prefixed to
 * avoid collisions with user state keys.
 *
 * Dependency: type-only imports from engine/ and scope/ (zero runtime cost).
 */
import type { ExecutionEnv } from '../engine/types.js';
import type { Recorder } from '../scope/types.js';
export interface ReactiveTarget {
    getValue(key?: string): unknown;
    setValue(key: string, value: unknown, shouldRedact?: boolean, description?: string): void;
    updateValue(key: string, value: unknown, description?: string): void;
    deleteValue(key: string, description?: string): void;
    /** Returns all state keys without firing onRead. Used by ownKeys/has traps. */
    getStateKeys?(): string[];
    /** Check key existence without firing onRead. Used by has trap. */
    hasKey?(key: string): boolean;
    /** Read state without firing onRead. Used by array proxy getCurrent(). */
    getValueSilent?(key?: string): unknown;
    getArgs<T = Record<string, unknown>>(): T;
    getEnv(): Readonly<ExecutionEnv>;
    attachRecorder(recorder: Recorder): void;
    detachRecorder(recorderId: string): void;
    getRecorders(): Recorder[];
    addDebugInfo(key: string, value: unknown): void;
    addDebugMessage(value: unknown): void;
    addErrorInfo(key: string, value: unknown): void;
    addMetric(name: string, value: unknown): void;
    addEval(name: string, value: unknown): void;
}
export interface ScopeMethods {
    $getValue(key: string): unknown;
    $setValue(key: string, value: unknown, shouldRedact?: boolean, description?: string): void;
    $update(key: string, value: unknown, description?: string): void;
    $delete(key: string, description?: string): void;
    /** Proxy-synthesized: calls getValue(rootKey) then lodash.get for nested path. Not a direct delegation. */
    $read(dotPath: string): unknown;
    $getArgs<T = Record<string, unknown>>(): T;
    $getEnv(): Readonly<ExecutionEnv>;
    $debug(key: string, value: unknown): void;
    $log(value: unknown): void;
    $error(key: string, value: unknown): void;
    $metric(name: string, value: unknown): void;
    $eval(name: string, value: unknown): void;
    $attachRecorder(recorder: Recorder): void;
    $detachRecorder(recorderId: string): void;
    $getRecorders(): Recorder[];
    /**
     * Batch-mutate an array key in a single clone+write cycle.
     *
     * Every `scope.items.push(x)` clones the entire array and commits it — O(N) per call.
     * For N mutations on an M-length array that is O(N×M). Use `$batchArray` to clone once,
     * apply all mutations inside `fn`, then commit once — O(M) total.
     *
     * ```typescript
     * // Before: 1000 clones × growing array = O(N²)
     * for (let i = 0; i < 1000; i++) scope.items.push(i);
     *
     * // After: 1 clone + 1 commit = O(N)
     * scope.$batchArray('items', (arr) => {
     *   for (let i = 0; i < 1000; i++) arr.push(i);
     * });
     * ```
     *
     * `fn` receives a plain (non-proxy) mutable **shallow copy** of the current array.
     * The array itself is a new instance, but object references inside it are shared with
     * the original state — mutations to nested objects inside `fn` affect those originals.
     * Only push/pop/sort/splice and other operations that change the array's own slots are
     * safely isolated.
     *
     * Mutations inside `fn` are NOT tracked individually — only the final committed array
     * appears in the narrative as a single write. If the key does not exist or is not an
     * array, `fn` receives an empty array and the result is committed as the new value.
     *
     * If `fn` throws, `setValue` is never called and state remains unchanged (atomic on
     * error). The exception propagates to the caller.
     *
     * `key` is untyped (`string`) — TypeScript will not catch typos. `arr` is typed as
     * `unknown[]` because `ScopeMethods` is not parameterized by `T`; cast inside `fn`
     * when element types are known: `(arr as string[]).push(x)`.
     */
    $batchArray(key: string, fn: (arr: unknown[]) => void): void;
    $break(): void;
    $toRaw(): ReactiveTarget;
}
export type TypedScope<T extends object = Record<string, unknown>> = T & ScopeMethods;
export interface ReactiveOptions {
    /** Pipeline break function -- injected by StageRunner after scope creation. */
    breakPipeline?: () => void;
}
export declare const SCOPE_METHOD_NAMES: Set<string>;
export declare const BREAK_SETTER: unique symbol;
export declare const IS_TYPED_SCOPE: unique symbol;
export declare const EXECUTOR_INTERNAL_METHODS: Set<string>;
