import type { StructuredErrorInfo } from '../errorInfo.js';

interface Identity {
  readonly runId: string;
  readonly runtimeStageId: string;
}
interface Pending {
  readonly error: unknown;
  readonly context: { readonly stage?: Identity };
}
export interface RetainedProjection {
  readonly message: string;
  readonly structuredError: StructuredErrorInfo;
}
export interface FailureReceipt {
  readonly kind: 'clear' | 'masked' | 'unknown';
  readonly projection?: RetainedProjection;
}
const readers = new WeakMap<object, () => Pending | undefined>();
const receipts = new WeakMap<object, FailureReceipt>();
const COMMIT_UNKNOWN: FailureReceipt = Object.freeze({ kind: 'unknown' });

/** Only the native class registers its private current pending token. */
export function registerFailureReader(state: object, read: () => Pending | undefined): void {
  readers.set(state, read);
}

export function failureReceipt(state: object, error: unknown): FailureReceipt | undefined {
  const pending = readers.get(state)?.();
  return pending && Object.is(pending.error, error) ? receipts.get(pending) : undefined;
}

/** A new commit failure invalidates invocation retention even without closure capture. */
export function invalidateFailureReceipt(state: object): void {
  const pending = readers.get(state)?.();
  if (pending) receipts.set(pending, COMMIT_UNKNOWN);
}

export function publishFailureReceipt(
  state: object,
  error: unknown,
  identity: Identity | undefined,
  projection: RetainedProjection,
  kind: FailureReceipt['kind'],
): void {
  const pending = readers.get(state)?.();
  if (
    !pending ||
    !identity ||
    !Object.is(pending.error, error) ||
    pending.context.stage?.runId !== identity.runId ||
    pending.context.stage.runtimeStageId !== identity.runtimeStageId
  )
    return;
  // A producer describing the replacement commit cannot revive an invocation memo.
  if (receipts.get(pending) === COMMIT_UNKNOWN && kind !== 'unknown') return;
  receipts.set(
    pending,
    Object.freeze({
      kind,
      projection: Object.freeze({
        message: projection.message,
        structuredError: Object.freeze({ ...projection.structuredError }),
      }),
    }),
  );
}
