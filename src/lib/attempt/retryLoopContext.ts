/** Internal one-call port: the builder declares logical identity; the call owner stamps it before dispatch. */
import type { RetryLoopCall } from './retryLoopTypes.js';
import type { AttemptRecord } from './types.js';

export interface RetryLoopCallPort {
  readonly identity: RetryLoopCall;
  readonly record: (record: AttemptRecord) => void;
}

const calls = new WeakMap<object, RetryLoopCallPort>();

export function registerRetryLoopCall(target: object, port: RetryLoopCallPort): () => void {
  if (calls.has(target)) throw new Error('retry loop: another call is already being prepared on this scope');
  calls.set(target, port);
  return () => {
    if (calls.get(target) === port) calls.delete(target);
  };
}

/** Claimed once, so nested calls made by the user's callback do not inherit the outer call's logical identity. */
export function takeRetryLoopCall(target: object): RetryLoopCallPort | undefined {
  const port = calls.get(target);
  calls.delete(target);
  return port;
}

export interface RetryLoopBudget {
  readonly passes?: number;
  readonly role: 'callback' | 'control' | 'wait';
  readonly timeoutMs?: number;
  readonly waitMs?: number;
}

const budgets = new WeakMap<object, RetryLoopBudget>();
export function declareRetryLoopBudget(node: object, budget: RetryLoopBudget): void {
  budgets.set(node, Object.freeze({ ...budget }));
}
export function retryLoopBudget(node: object): RetryLoopBudget | undefined {
  return budgets.get(node);
}
