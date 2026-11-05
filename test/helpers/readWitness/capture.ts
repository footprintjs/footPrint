/** Minimal observer lifetime. No fixture imports, programs, native policy profile or product record. */
import { installReadLawObservation } from './observation.js';
import type { Hooks, Receipt } from './observationTypes.js';
export interface NativeCapture<T> {
  readonly value: T;
  readonly native: Receipt;
}
type Observer = ReturnType<typeof installReadLawObservation>;
function settle<T>(
  observer: Observer,
  failed: boolean,
  primary: unknown,
  result: NativeCapture<T> | undefined,
): NativeCapture<T> {
  let cleanup: unknown;
  let cleanupFailed = false;
  try {
    observer.restore();
  } catch (error) {
    cleanup = error;
    cleanupFailed = true;
  }
  if (failed && cleanupFailed) throw new AggregateError([primary, cleanup], 'Native run and restoration both failed.');
  if (failed) throw primary;
  if (cleanupFailed) throw cleanup;
  return result!;
}
export function captureNativeSync<T>(engine: Hooks, leg: string, fn: () => T): NativeCapture<T> {
  const observer = installReadLawObservation(engine, leg);
  let result: NativeCapture<T> | undefined;
  let failed = false;
  let primary: unknown;
  try {
    const value = fn();
    observer.assertUsable();
    result = Object.freeze({ value, native: observer.receipt() });
  } catch (error) {
    primary = error;
    failed = true;
  }
  return settle(observer, failed, primary, result);
}
export async function captureNative<T>(
  engine: Hooks,
  leg: string,
  fn: () => Promise<T> | T,
): Promise<NativeCapture<T>> {
  const observer = installReadLawObservation(engine, leg);
  let result: NativeCapture<T> | undefined;
  let failed = false;
  let primary: unknown;
  try {
    const value = await fn();
    observer.assertUsable();
    result = Object.freeze({ value, native: observer.receipt() });
  } catch (error) {
    primary = error;
    failed = true;
  }
  return settle(observer, failed, primary, result);
}
