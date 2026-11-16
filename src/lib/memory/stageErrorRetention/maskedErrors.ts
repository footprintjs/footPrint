import type { StructuredErrorInfo } from '../../errors/errorInfo.js';

interface Mask {
  readonly info: StructuredErrorInfo;
  readonly strength: number;
}

/**
 * Masked thrown values → their served form. An object (an Error, a thrown record) is held WEAKLY: a run whose calls
 * fail thousands of times (`scope.$call`, P2) must not keep every thrown value alive for the run's life. A thrown
 * scalar (a string, a number) is matched by value, so it is held by value. `any` gates the serving walk: it says a
 * value was ever masked, not that one is still alive (a false positive costs one walk, never a leak).
 */
export class MaskedErrors {
  private readonly objects = new WeakMap<object, Mask>();
  private readonly scalars = new Map<unknown, Mask>();
  /** Whether anything was ever masked. */
  any = false;

  get(value: unknown): StructuredErrorInfo | undefined {
    return (isWeakKey(value) ? this.objects.get(value) : this.scalars.get(value))?.info;
  }

  /** Whether `value` was served masked (and, for an object, is still alive) — the `Map` reading consumers rely on. */
  has(value: unknown): boolean {
    return isWeakKey(value) ? this.objects.has(value) : this.scalars.has(value);
  }

  strength(value: unknown): number {
    return (isWeakKey(value) ? this.objects.get(value) : this.scalars.get(value))?.strength ?? -1;
  }

  set(value: unknown, info: StructuredErrorInfo, strength = 0): void {
    this.any = true;
    if (this.strength(value) > strength) return;
    const mask = { info, strength };
    if (isWeakKey(value)) this.objects.set(value, mask);
    else this.scalars.set(value, mask);
  }
}

export function isWeakKey(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}
