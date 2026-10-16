/** Explicit retry workflow: ordinary attempt → reconcile → decide → wait/loop nodes, one rule table. */
import { parseRuntimeStageId } from 'foottrace';

import { decideAttempt, retryRules } from '../attempt/decision.js';
import { admitIdempotencyKey, touchesProblem } from '../attempt/effect.js';
import { UnknownEffectError } from '../attempt/errors.js';
import { cappedWaitMs, retryPolicyProblem } from '../attempt/policy.js';
import type { RetryLoopBudget } from '../attempt/retryLoopContext.js';
import { registerRetryLoopCall } from '../attempt/retryLoopContext.js';
import type { RetryLoopCall } from '../attempt/retryLoopTypes.js';
import { resolveBackoffMs, sleep } from '../attempt/runner.js';
import type {
  AttemptContext,
  AttemptEffect,
  AttemptError,
  AttemptInputs,
  AttemptRecord,
  CallOptions,
  IdempotencyKeyContext,
  RetryPolicy,
} from '../attempt/types.js';
import type { DecisionEvidence } from '../decide/types.js';
import { DECISION_RESULT } from '../decide/types.js';
import { interrupt, isInterruptSignal } from '../pause/interrupt.js';
import { isPauseSignal } from '../pause/types.js';
import { requireScopeRuntime } from '../scope/runtime.js';

export interface RetryLoopContext extends AttemptContext {
  readonly retryLoop: RetryLoopCall;
}

export interface RetryLoopOptions<TScope = any, TValue = unknown> {
  readonly touches: string;
  readonly idempotencyKey: (context: IdempotencyKeyContext) => string;
  readonly retry: RetryPolicy;
  readonly attempt: (scope: TScope, context: RetryLoopContext) => TValue | Promise<TValue>;
  /** 'none' must authoritatively establish that the operation was not applied; an empty search is not enough. */
  readonly reconcile: (scope: TScope, context: RetryLoopContext) => AttemptEffect | Promise<AttemptEffect>;
  readonly into?: string;
  readonly onStop?: 'throw' | 'continue';
  readonly wait?: 'sleep' | 'pause';
}

/** Operational state stays real; normal state retention scrubs selected keys and every error is already served. */
export interface RetryLoopState<TValue = unknown> {
  readonly id: string;
  readonly series: string;
  readonly attempt: number;
  readonly of: number;
  readonly idempotencyKey: string;
  readonly effect: AttemptEffect;
  readonly reconciled: boolean;
  readonly outcome?: AttemptRecord['outcome'];
  readonly category?: AttemptRecord['category'];
  readonly error?: AttemptError;
  readonly value?: TValue;
  readonly delayMs: number;
  readonly retryOn: boolean;
  readonly retryOnThrew?: true;
  readonly decision?: DecisionEvidence;
  readonly terminal: boolean;
  readonly resumeAt?: number;
}

interface Host {
  getValue(key: string): unknown;
  getAttempt(): AttemptContext;
  call<T>(
    target: string,
    fn: (context: AttemptContext) => T | Promise<T>,
    policy: RetryPolicy,
    options?: CallOptions,
  ): Promise<T>;
  writeRetryLoopState(key: string, state: RetryLoopState): void;
  serveRetryLoopKey(key: string): string;
  serveRetryLoopError(error: unknown): AttemptError;
}

/** Builder-only composition interface; no runtime engine kind or new scope method. */
interface Builder {
  addFunction(name: string, fn: (scope: any) => any, id: string): this;
  addPausableFunction(
    name: string,
    handler: { execute(scope: any): any; resume(scope: any, input: unknown): any },
    id: string,
  ): this;
  addDeciderFunction(
    name: string,
    fn: (scope: any) => any,
    id: string,
  ): {
    addFunctionBranch(branch: string, name: string, fn: (scope: any) => any, id?: string, options?: any): any;
    end(): Builder;
  };
  touches(system: string, options: { idempotencyKey: (context: IdempotencyKeyContext) => string }): this;
  tag(...names: string[]): this;
}

const fail = (field: string): never => {
  throw new TypeError(`addRetryLoop: invalid ${field}`);
};

export function appendRetryLoop<TScope>(
  builder: Builder,
  id: string,
  supplied: RetryLoopOptions<TScope>,
  stamp: (budget: RetryLoopBudget, branch?: string) => void,
): void {
  // Snapshot named configuration once; never retain arbitrary caller fields or invoke a policy callback at build.
  if (supplied === null || typeof supplied !== 'object') fail('options');
  const {
    touches,
    idempotencyKey,
    retry: given,
    attempt,
    reconcile,
    into = id,
    onStop = 'throw',
    wait = 'sleep',
  } = supplied;
  if (given === null || typeof given !== 'object') fail('retry');
  const { attempts, timeoutMs, backoffMs, maxBackoffMs, retryOn } = given;
  const retry: RetryPolicy = Object.freeze({ attempts, timeoutMs, backoffMs, maxBackoffMs, retryOn });
  if (retryPolicyProblem(retry) || !Number.isSafeInteger(attempts)) fail('retry policy');
  if (touchesProblem({ system: touches, idempotencyKey }, retry) || typeof idempotencyKey !== 'function')
    fail('key rule or system');
  if (typeof attempt !== 'function' || typeof reconcile !== 'function') fail('attempt or reconciliation callback');
  if (
    typeof into !== 'string' ||
    !into ||
    into.startsWith('$') ||
    ['__proto__', 'constructor', 'prototype'].includes(into)
  )
    fail('state key');
  if (onStop !== 'throw' && onStop !== 'continue') fail('onStop');
  if (wait !== 'sleep' && wait !== 'pause') fail('wait');
  const tag = `retry-loop:${id}`;
  const callbackBudget: RetryLoopBudget = { role: 'callback', timeoutMs };
  const waitBudget: RetryLoopBudget = {
    role: 'wait',
    waitMs: typeof backoffMs === 'function' ? maxBackoffMs : cappedWaitMs(resolveBackoffMs(backoffMs, 1), maxBackoffMs),
  };
  const controlBudget: RetryLoopBudget = { role: 'control' };

  const hostOf = (scope: unknown): Host => {
    const host = requireScopeRuntime(scope).target as unknown as Host;
    if (typeof host.writeRetryLoopState !== 'function') fail('scope capability (use a registered ScopeFacade target)');
    return host;
  };
  const checked = (value: unknown): RetryLoopState | undefined => {
    if (value === undefined) return undefined;
    if (value === null || typeof value !== 'object') fail('restored loop state');
    const state = value as RetryLoopState;
    if (
      state.error !== undefined &&
      (state.error === null ||
        typeof state.error !== 'object' ||
        typeof state.error.message !== 'string' ||
        Object.keys(state.error).some((key) => !['message', 'name', 'code'].includes(key)))
    )
      fail('restored loop error');
    if (state.resumeAt !== undefined && (typeof state.resumeAt !== 'number' || !Number.isFinite(state.resumeAt)))
      fail('restored wait time');
    if (
      state.id !== id ||
      state.of !== attempts ||
      !Number.isInteger(state.attempt) ||
      state.attempt < 1 ||
      state.attempt > attempts ||
      typeof state.idempotencyKey !== 'string' ||
      state.idempotencyKey.trim() === '' ||
      typeof state.series !== 'string' ||
      typeof state.terminal !== 'boolean' ||
      !['none', 'unknown', 'applied'].includes(state.effect) ||
      typeof state.reconciled !== 'boolean' ||
      typeof state.retryOn !== 'boolean' ||
      !Number.isFinite(state.delayMs) ||
      state.delayMs < 0
    )
      fail('restored loop state');
    try {
      const parsed = parseRuntimeStageId(state.series);
      if (!/#\d+$/.test(state.series) || parsed.stageId !== id) fail('restored loop series');
      admitIdempotencyKey('addRetryLoop', state.idempotencyKey);
    } catch {
      fail('restored loop series');
    }
    return state;
  };
  const read = (host: Host): RetryLoopState | undefined => checked(host.getValue(into));
  const identity = (state: RetryLoopState, phase: RetryLoopCall['phase']): RetryLoopCall =>
    Object.freeze({ id, series: state.series, attempt: state.attempt, of: attempts, phase });
  const call = async <T>(
    scope: TScope,
    host: Host,
    state: RetryLoopState,
    phase: RetryLoopCall['phase'],
    fn: (scope: TScope, context: RetryLoopContext) => T | Promise<T>,
  ): Promise<{ value?: T; error?: unknown; record?: AttemptRecord }> => {
    let record: AttemptRecord | undefined;
    const logical = identity(state, phase);
    const clear = registerRetryLoopCall(host, {
      identity: logical,
      record: (entry) => {
        record = entry;
      },
    });
    try {
      const value = await host.call(
        phase === 'attempt' ? touches : `${touches}.reconcile`,
        (context) => fn(scope, Object.freeze({ ...context, idempotencyKey: state.idempotencyKey, retryLoop: logical })),
        { attempts: 1, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
        phase === 'attempt' ? { touches, idempotencyKey: state.idempotencyKey } : undefined,
      );
      return { value, record };
    } catch (error) {
      if (isPauseSignal(error) || isInterruptSignal(error)) throw error;
      return { error, record };
    } finally {
      clear();
    }
  };

  builder
    .addFunction(
      `Attempt ${id}`,
      async (scope: TScope) => {
        const host = hostOf(scope);
        const previous = read(host);
        let state: RetryLoopState =
          previous && !previous.terminal
            ? { ...previous, reconciled: false }
            : {
                id,
                series: host.getAttempt().series,
                attempt: 1,
                of: attempts,
                idempotencyKey: host.getAttempt().idempotencyKey as string,
                effect: 'none',
                reconciled: false,
                delayMs: 0,
                retryOn: true,
                terminal: false,
              };
        host.writeRetryLoopState(into, state); // a pause re-runs from this committed operational key, never recomputes it
        const result = await call(scope, host, state, 'attempt', attempt);
        const record = result.record;
        const failed = Object.hasOwn(result, 'error');
        let allows = true;
        let threw = false;
        let delayMs = 0;
        if (failed && state.attempt < attempts) {
          const original = result.error instanceof UnknownEffectError ? result.error.cause : result.error;
          if (retryOn) {
            try {
              allows = retryOn(original) === true;
            } catch {
              allows = false;
              threw = true;
            }
          }
          if (allows) delayMs = cappedWaitMs(resolveBackoffMs(backoffMs, state.attempt, original), maxBackoffMs);
        }
        state = {
          ...state,
          outcome: record?.outcome ?? (failed ? 'failed' : 'ok'),
          effect: record?.effect ?? (failed ? 'unknown' : 'applied'),
          category: record?.category,
          ...(failed ? { error: host.serveRetryLoopError(result.error) } : { value: result.value }),
          retryOn: allows,
          ...(threw ? { retryOnThrew: true } : {}),
          delayMs,
        };
        host.writeRetryLoopState(into, state);
      },
      id,
    )
    .touches(touches, {
      idempotencyKey: (context) => {
        const previous = checked(context.getState(into));
        return previous && !previous.terminal ? previous.idempotencyKey : idempotencyKey(context);
      },
    })
    .tag(tag);
  stamp({ ...callbackBudget, passes: attempts });

  builder
    .addFunction(
      `Reconcile ${id}`,
      async (scope: TScope) => {
        const host = hostOf(scope);
        const state = read(host) as RetryLoopState;
        if (state.effect !== 'unknown') return;
        const result = await call(scope, host, state, 'reconcile', reconcile);
        const valid = result.value === 'applied' || result.value === 'none' || result.value === 'unknown';
        const effect = valid ? (result.value as AttemptEffect) : 'unknown';
        host.writeRetryLoopState(into, {
          ...state,
          effect,
          reconciled: true,
          ...(Object.hasOwn(result, 'error')
            ? { error: host.serveRetryLoopError(result.error) }
            : !valid
            ? { error: { name: 'TypeError', message: 'retry loop: invalid reconciliation outcome' } }
            : {}),
        });
      },
      `${id}-reconcile`,
    )
    .tag(tag);
  stamp(callbackBudget);

  const decider = builder.addDeciderFunction(
    `Decide ${id}`,
    (scope: TScope) => {
      const host = hostOf(scope);
      const state = read(host) as RetryLoopState;
      const context = host.getAttempt();
      const left = context.timeLeftMs();
      const inputs: AttemptInputs = {
        outcome: state.effect === 'applied' ? 'ok' : state.outcome ?? 'failed',
        category: state.category,
        aborted: context.signal.aborted,
        attempt: state.attempt,
        of: attempts,
        timeLeftMs: left,
        delayMs: state.delayMs,
        timeLeftAfterWaitMs: left - state.delayMs,
        retryOn: state.retryOn && state.effect !== 'unknown',
        keyPresent: true,
      };
      const decision = decideAttempt(retryRules(retry), (key) => inputs[key as keyof AttemptInputs]);
      const evidence: DecisionEvidence = {
        ...decision.evidence,
        retryLoop: Object.freeze({
          id,
          series: state.series,
          attempt: state.attempt,
          of: attempts,
          effect: state.effect,
          reconciled: state.reconciled,
          next: decision.next,
          reason: decision.reason,
        }),
      };
      host.writeRetryLoopState(into, { ...state, decision: evidence, terminal: decision.next !== 'retry' });
      return { branch: `${id}-${decision.next}`, [DECISION_RESULT]: true, evidence };
    },
    `${id}-decide`,
  );
  builder.tag(tag);
  stamp(controlBudget);

  const waitScope = async (scope: TScope): Promise<void> => {
    const host = hostOf(scope);
    const state = read(host) as RetryLoopState;
    const delay = state.resumeAt === undefined ? state.delayMs : Math.max(0, state.resumeAt - Date.now());
    const signal = host.getAttempt().signal;
    await sleep(delay, signal);
    if (signal.aborted) throw signal.reason ?? new Error('retry loop aborted');
    host.writeRetryLoopState(into, { ...state, attempt: state.attempt + 1, decision: undefined, resumeAt: undefined });
  };
  // Branch-list methods keep their builder cursor on the decider. The wait callback is an ordinary branch;
  // pause mode uses interrupt semantics in that callback so its own stage resumes before it loops back.
  const waitFn =
    wait === 'pause'
      ? async (scope: TScope) => {
          const host = hostOf(scope);
          const state = read(host) as RetryLoopState;
          if (state.resumeAt === undefined)
            host.writeRetryLoopState(into, { ...state, resumeAt: Date.now() + state.delayMs });
          interrupt(scope, { reason: `Retry ${id}`, expects: { resumeAt: (read(host) as RetryLoopState).resumeAt } });
          await waitScope(scope);
        }
      : waitScope;
  decider
    .addFunctionBranch(`${id}-retry`, `Wait ${id}`, waitFn, undefined, { loopTo: id, tags: [tag] })
    .addFunctionBranch(`${id}-done`, `Done ${id}`, () => undefined, undefined, { tags: [tag] })
    .addFunctionBranch(
      `${id}-stop`,
      `Stop ${id}`,
      (scope: TScope) => {
        if (onStop === 'continue') return;
        const host = hostOf(scope);
        const state = read(host) as RetryLoopState;
        const cause = Object.assign(new Error(state.error?.message ?? 'retry loop stopped'), {
          name: state.error?.name ?? 'Error',
          ...(state.error?.code ? { code: state.error.code } : {}),
        });
        if (state.effect === 'unknown')
          throw new UnknownEffectError({
            system: touches,
            idempotencyKey: host.serveRetryLoopKey(state.idempotencyKey),
            attempts: state.attempt,
            cause,
          });
        throw cause;
      },
      undefined,
      { tags: [tag] },
    )
    .end();
  // Branch nodes are assigned their bounded helper costs by the builder after construction.
  stamp(waitBudget, `${id}-retry`);
  stamp(controlBudget, `${id}-done`);
  stamp(controlBudget, `${id}-stop`);
}
