import type { StructuredErrorInfo } from '../../errors/errorInfo.js';

/**
 * Masked thrown values → their served form. An object (an Error, a thrown record) is held WEAKLY: a run whose calls
 * fail thousands of times (`scope.$call`, P2) must not keep every thrown value alive for the run's life. A thrown
 * scalar (a string, a number) is matched by value, so it is held by value. `any` gates the serving walk: it says a
 * value was ever masked, not that one is still alive (a false positive costs one walk, never a leak).
 */
export class MaskedErrors {
  private readonly objects = new WeakMap<object, StructuredErrorInfo>();
  private readonly scalars = new Map<unknown, StructuredErrorInfo>();
  /** Whether anything was ever masked. */
  any = false;

  get(value: unknown): StructuredErrorInfo | undefined {
    return isWeakKey(value) ? this.objects.get(value) : this.scalars.get(value);
  }

  /** Whether `value` was served masked (and, for an object, is still alive) — the `Map` reading consumers rely on. */
  has(value: unknown): boolean {
    return isWeakKey(value) ? this.objects.has(value) : this.scalars.has(value);
  }

  set(value: unknown, info: StructuredErrorInfo): void {
    this.any = true;
    if (isWeakKey(value)) this.objects.set(value, info);
    else this.scalars.set(value, info);
  }
}

export function isWeakKey(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}
