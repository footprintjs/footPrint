export type DetachBoundaryReason = 'worker-boundary' | 'transport-boundary' | 'missing-child';

export interface DetachBoundaryObserver {
  noteBoundary(reason: DetachBoundaryReason): void;
}

// Private identity prevents a driver's public name or capability claims from certifying a boundary.
const boundaries = new WeakMap<object, Exclude<DetachBoundaryReason, 'missing-child'>>();

export function markDetachBoundary<T extends object>(
  driver: T,
  reason: Exclude<DetachBoundaryReason, 'missing-child'>,
): T {
  boundaries.set(driver, reason);
  return driver;
}

export function detachBoundary(driver: object): DetachBoundaryReason {
  return boundaries.get(driver) ?? 'missing-child';
}
