import type { AttemptCategory } from '../attempt/types.js';

/** Safe context for the failure that escaped a native run; never the exception itself. */
export interface TerminalFailureContext {
  readonly category: AttemptCategory;
  /** Absent when no native stage owns this failure (for example input admission or run retention). */
  readonly stage?: {
    readonly runId: string;
    readonly runtimeStageId: string;
  };
}

/**
 * @internal Safe native operation selected by the exact escaping error. This is distinct from the legacy
 * served context: an invocation identifies an actual call, while a commit must never borrow that call's id.
 */
export type SelectedNativeFailure =
  | {
      readonly kind: 'invocation';
      readonly runId: string;
      readonly runtimeStageId: string;
      readonly attemptId: string;
    }
  | { readonly kind: 'commit'; readonly runId: string; readonly runtimeStageId: string };

type InvocationFailure = Extract<SelectedNativeFailure, { readonly kind: 'invocation' }>;

const UNKNOWN: TerminalFailureContext = Object.freeze({ category: 'unknown' });

/**
 * @internal One execution chain's failure ownership, not an error history.
 * Sequential frames share it; forks and subflows do not. Only an explicitly
 * selected escaping rejection may transfer ownership to its parent chain.
 * Raw identity lives in a private slot and is released when the leg settles.
 */
export class NativeFailureState {
  #pending?: { error: unknown; context: TerminalFailureContext; selected?: SelectedNativeFailure };
  #invocation?: { error: unknown; selected: InvocationFailure };
  #result?: TerminalFailureContext;
  #selected?: SelectedNativeFailure;
  #sealed = false;

  get result(): TerminalFailureContext | undefined {
    return this.#result;
  }

  /** @internal Published separately; ordinary failure contexts and off-path snapshots retain their shape. */
  get selected(): SelectedNativeFailure | undefined {
    return this.#selected;
  }

  /** @internal An existing native catch observed this invocation's own error, before any serving callbacks. */
  observeInvocationFailure(error: unknown, invocation: InvocationFailure): void {
    if (this.#sealed) return;
    this.#invocation = {
      error,
      selected: Object.freeze({
        kind: 'invocation',
        runId: invocation.runId,
        runtimeStageId: invocation.runtimeStageId,
        attemptId: invocation.attemptId,
      }),
    };
  }

  /** @internal A new attempt's preparation cannot inherit a recovered invocation's error. */
  clearInvocationFailure(): void {
    if (!this.#sealed) this.#invocation = undefined;
  }

  capture(error: unknown, category: AttemptCategory, stage: NonNullable<TerminalFailureContext['stage']>): void {
    if (this.#sealed) return;
    const invocation = this.#invocation;
    const selected =
      invocation &&
      Object.is(invocation.error, error) &&
      invocation.selected.runId === stage.runId &&
      invocation.selected.runtimeStageId === stage.runtimeStageId
        ? invocation.selected
        : undefined;
    this.#pending = {
      error,
      context: Object.freeze({
        category,
        stage: Object.freeze({ runId: stage.runId, runtimeStageId: stage.runtimeStageId }),
      }),
      ...(selected && { selected }),
    };
  }

  /** @internal A commit is a different operation, even if it throws the very same object as the function. */
  selectCommit(error: unknown, stage: NonNullable<TerminalFailureContext['stage']>): void {
    const pending = this.#pending;
    if (this.#sealed || !pending || !Object.is(pending.error, error)) return;
    pending.selected =
      pending.context.stage?.runId === stage.runId && pending.context.stage.runtimeStageId === stage.runtimeStageId
        ? Object.freeze({ kind: 'commit', runId: stage.runId, runtimeStageId: stage.runtimeStageId })
        : undefined;
    this.#invocation = undefined;
  }

  /** A runner already classified this exact native failure before it was served. */
  owns(error: unknown): boolean {
    return this.#pending !== undefined && Object.is(this.#pending.error, error);
  }

  adopt(child: NativeFailureState, error: unknown): void {
    if (!this.#sealed) this.#pending = child.owns(error) ? child.#pending : undefined;
    child.complete();
  }

  /** Publish at the run event boundary; keep ownership until executor settlement. */
  announce(error: unknown): TerminalFailureContext {
    if (this.#sealed) return this.#result ?? UNKNOWN;
    const pending = this.#pending;
    const context = pending && Object.is(pending.error, error) ? pending.context : UNKNOWN;
    this.#result = context;
    this.#selected = pending && Object.is(pending.error, error) ? pending.selected : undefined;
    return context;
  }

  finish(error: unknown): void {
    if (this.#sealed) return;
    this.announce(error);
    this.#pending = undefined;
    this.#invocation = undefined;
    this.#sealed = true;
  }

  /** Success or pause has no terminal failure. Also closes contained branch ownership. */
  complete(): void {
    if (this.#sealed) return;
    this.#pending = undefined;
    this.#invocation = undefined;
    this.#result = undefined;
    this.#selected = undefined;
    this.#sealed = true;
  }
}
