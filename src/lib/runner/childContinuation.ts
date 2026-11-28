import type { RunOptions } from '../engine/types.js';
import {
  type ChildContinuationBinding,
  type ChildGate,
  type SavedWait,
  type SavedWaitRefusal,
  readSavedWait,
  saveWait,
} from './childContinuationRecord.js';
import type { FlowChartExecutor } from './FlowChartExecutor.js';
import type { ResumeOptions } from './RunLifecycle.js';

export type { ChildContinuationBinding, ChildGate } from './childContinuationRecord.js';

export type ChildContinuationInitial = { readonly kind: 'new' } | { readonly kind: 'restore'; readonly saved: string };

export type ChildContinuationEntry =
  | { readonly kind: 'start'; readonly options?: RunOptions }
  | {
      readonly kind: 'answer';
      readonly gate: ChildGate;
      readonly answer: unknown;
      readonly options?: ResumeOptions;
    };

type Refusal = SavedWaitRefusal | 'wrong-gate' | 'missing-child' | 'in-flight' | 'retired';

export type ChildContinuationOutcome =
  | {
      readonly kind: 'waiting';
      readonly gate: ChildGate;
      /** Native, private pause data. The host owns any authorized question projection. */
      readonly pauseData: unknown;
      /** Private JSON. Keep it out of model messages, records and public UI. */
      readonly saved: string;
    }
  | { readonly kind: 'finished'; readonly value: unknown }
  | { readonly kind: 'unavailable'; readonly reason: Refusal };

export interface ChildContinuation {
  advance(entry: ChildContinuationEntry): Promise<ChildContinuationOutcome>;
}

type Executor = Pick<FlowChartExecutor, 'run' | 'resume' | 'getCheckpoint'>;
type ResolveChild = (implementation: string) => Executor | undefined | Promise<Executor | undefined>;

type State =
  | { readonly kind: 'new' }
  | { readonly kind: 'waiting'; readonly wait: SavedWait }
  | { readonly kind: 'unavailable'; readonly reason: SavedWaitRefusal | 'retired' };

type Leg = { run(executor: Executor): Promise<unknown>; readonly revision: number };

function initialState(binding: ChildContinuationBinding, initial: ChildContinuationInitial): State {
  if (
    typeof binding.occurrence !== 'string' ||
    !binding.occurrence ||
    typeof binding.implementation !== 'string' ||
    !binding.implementation
  ) {
    return { kind: 'unavailable', reason: 'invalid-continuation' };
  }
  if (initial.kind === 'new') return { kind: 'new' };
  const restored = readSavedWait(binding, initial.saved);
  return typeof restored === 'string' ? { kind: 'unavailable', reason: restored } : { kind: 'waiting', wait: restored };
}

function planLeg(state: Exclude<State, { kind: 'unavailable' }>, entry: ChildContinuationEntry): Leg | undefined {
  if (state.kind === 'new' && entry.kind === 'start') {
    const { options } = entry;
    return { run: (executor) => executor.run(options), revision: 1 };
  }
  if (state.kind !== 'waiting' || entry.kind !== 'answer') return;
  const { checkpoint, gate } = state.wait;
  const addressed = entry.gate;
  if (addressed?.id !== gate.id || addressed.revision !== gate.revision || gate.revision === Number.MAX_SAFE_INTEGER)
    return;
  const { answer, options } = entry;
  return { run: (executor) => executor.resume(checkpoint, answer, options), revision: gate.revision + 1 };
}

/**
 * Wait for a separately executed child through native run and resume. The loader admits
 * the immutable implementation, returning a fresh executor for each admitted leg.
 * The host owns authorization, selection of its current saved value and durable claims
 * across processes. This handle serializes and spends accepted entries in this process.
 */
export function createChildContinuation(
  binding: ChildContinuationBinding,
  resolve: ResolveChild,
  initial: ChildContinuationInitial,
): ChildContinuation {
  const selected = { occurrence: binding.occurrence, implementation: binding.implementation };
  let state = initialState(selected, initial);
  let inFlight = false;
  return {
    async advance(entry) {
      if (inFlight) return { kind: 'unavailable', reason: 'in-flight' };
      if (state.kind === 'unavailable') return { kind: 'unavailable', reason: state.reason };
      inFlight = true;
      try {
        const leg = planLeg(state, entry);
        if (!leg) return { kind: 'unavailable', reason: 'wrong-gate' };
        const executor = await resolve(selected.implementation);
        if (!executor) return { kind: 'unavailable', reason: 'missing-child' };
        // Once the native leg is admitted, only that leg may offer a replacement. Rejection keeps it retired.
        state = { kind: 'unavailable', reason: 'retired' };
        const value = await leg.run(executor);
        const checkpoint = executor.getCheckpoint();
        if (!checkpoint) return { kind: 'finished', value };

        const wait = saveWait(selected, checkpoint, leg.revision);
        if (typeof wait === 'string') return { kind: 'unavailable', reason: wait };
        state = { kind: 'waiting', wait };
        return {
          kind: 'waiting',
          gate: { ...wait.gate },
          pauseData: structuredClone(wait.checkpoint.pauseData),
          saved: wait.saved,
        };
      } finally {
        inFlight = false;
      }
    },
  };
}
