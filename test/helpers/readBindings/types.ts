import type { JoinedRun, ReadPair } from '../readLawWitness.js';
import type { NativeFact, OperationSpan, Receipt } from '../readWitness.js';
export type BasicFamily = 'chart' | 'nested' | 'writeback';
export interface ObservedKept extends JoinedRun {
  readonly operations: readonly OperationSpan[];
}
export interface QualifiedPair {
  readonly pair: ReadPair;
  readonly baselineRead: NativeFact;
  readonly buildRead: NativeFact;
  readonly baselineSpan: OperationSpan;
  readonly buildSpan: OperationSpan;
  readonly baselineCalls: readonly NativeFact[];
  readonly buildCalls: readonly NativeFact[];
}
export type BindingResult =
  | { readonly kind: 'bindings'; readonly reads: readonly QualifiedPair[] }
  | { readonly kind: 'unproven'; readonly reason: string };
export type RetainedBindingResult =
  | { readonly kind: 'retained-bindings'; readonly pairs: readonly ReadPair[] }
  | { readonly kind: 'unproven'; readonly reason: string };
export const own = (value: unknown, key: PropertyKey): unknown => {
  if (value === null || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor !== undefined && !Object.hasOwn(descriptor, 'value')) throw new Error('Non-data retained slot.');
  return descriptor?.value;
};
export const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const stageReads = (native: Receipt) =>
  native.events.filter(
    (event) =>
      event.tier === 'stage-call' &&
      ['getValue', 'getValueDirect'].includes(event.method) &&
      event.phase === 'read' &&
      event.outcome === 'returned',
  );
