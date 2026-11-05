/** One observed family lifetime. No engine or fixture runtime import. */
import type { HeapProfile, Hooks, OperationSpan, Profile, Receipt } from '../readWitness.js';
import type { installReadLawObservation } from '../readWitness.js';
export type NativeObserver = ReturnType<typeof installReadLawObservation>;
export interface WitnessMetadata {
  readonly bytes: string;
  readonly foldsBack: boolean;
  readonly nativeId?: number;
}
export interface ObservationOptions {
  readonly engine: Hooks;
  readonly program: unknown;
  readonly leg: string;
  readonly heapProfile?: HeapProfile;
  readonly producer: {
    readonly profile: Profile;
    readonly snapshotRows: (value: unknown) => string;
    readonly snapshotPaths: (value: unknown) => string;
  };
}
export interface ObservedFamily<T> {
  readonly value: T;
  readonly commits: readonly WitnessMetadata[];
  readonly native: Receipt;
  readonly operations: readonly OperationSpan[];
  readonly program: string;
}
const programBytes = (program: unknown) => {
  // Program is the actual unchanged generated data, not retained record data: never apply VOLATILE here.
  const result = JSON.stringify(program);
  if (typeof result !== 'string') throw new Error('Applied program is not JSON data.');
  return result;
};
type Work<T> = { value: T; commits: readonly WitnessMetadata[] };
/** Native install is the ONE existing adapter; injecting it permits inert lifetime controls. */
export function createObservedFamilyDriver(install: typeof installReadLawObservation) {
  const open = (options: ObservationOptions) => {
    const before = programBytes(options.program);
    const native =
      options.heapProfile === undefined
        ? install(options.engine, options.leg, options.producer)
        : install(options.engine, options.leg, options.producer, options.heapProfile);
    return { native, before };
  };
  const finish = <T>(
    options: ObservationOptions,
    native: NativeObserver,
    before: string,
    work: Work<T>,
  ): ObservedFamily<T> => {
    native.assertUsable();
    if (programBytes(options.program) !== before) throw new Error('Observation run changed its applied program bytes.');
    const operationReceipt = native.operations.receipt();
    if (operationReceipt.issues.length) throw new Error('Unusable operation observation.');
    return Object.freeze({
      value: work.value,
      commits: work.commits,
      native: native.receipt(),
      operations: operationReceipt.spans,
      program: before,
    });
  };
  const settle = <T>(native: NativeObserver, failed: boolean, primary: unknown, result: T | undefined): T => {
    let cleanup: unknown;
    let cleanupFailed = false;
    try {
      native.restore();
    } catch (error) {
      cleanupFailed = true;
      cleanup = error;
    }
    if (failed && cleanupFailed)
      throw new AggregateError([primary, cleanup], 'Observed run and restoration both failed.');
    if (failed) throw primary; // Preserve even null/undefined/non-Error escaping identities.
    if (cleanupFailed) throw cleanup;
    return result!;
  };
  return {
    sync<T>(options: ObservationOptions, work: (native: NativeObserver) => Work<T>): ObservedFamily<T> {
      const { native, before } = open(options);
      let result: ObservedFamily<T> | undefined;
      let failed = false;
      let primary: unknown;
      try {
        result = finish(options, native, before, work(native));
      } catch (error) {
        failed = true;
        primary = error;
      }
      return settle(native, failed, primary, result);
    },
    async async<T>(
      options: ObservationOptions,
      work: (native: NativeObserver) => Promise<Work<T>>,
    ): Promise<ObservedFamily<T>> {
      const { native, before } = open(options);
      let result: ObservedFamily<T> | undefined;
      let failed = false;
      let primary: unknown;
      try {
        result = finish(options, native, before, await work(native));
      } catch (error) {
        failed = true;
        primary = error;
      }
      return settle(native, failed, primary, result);
    },
  };
}
