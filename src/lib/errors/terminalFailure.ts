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

const UNKNOWN: TerminalFailureContext = Object.freeze({ category: 'unknown' });

/**
 * @internal One execution chain's failure ownership, not an error history.
 * Sequential frames share it; forks and subflows do not. Only an explicitly
 * selected escaping rejection may transfer ownership to its parent chain.
 * Raw identity lives in a private slot and is released when the leg settles.
 */
export class NativeFailureState {
  #pending?: { error: unknown; context: TerminalFailureContext };
  #result?: TerminalFailureContext;
  #sealed = false;

  get result(): TerminalFailureContext | undefined {
    return this.#result;
  }

  capture(error: unknown, category: AttemptCategory, stage: NonNullable<TerminalFailureContext['stage']>): void {
    if (this.#sealed) return;
    this.#pending = {
      error,
      context: Object.freeze({
        category,
        stage: Object.freeze({ runId: stage.runId, runtimeStageId: stage.runtimeStageId }),
      }),
    };
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
    return context;
  }

  finish(error: unknown): void {
    if (this.#sealed) return;
    this.announce(error);
    this.#pending = undefined;
    this.#sealed = true;
  }

  /** Success or pause has no terminal failure. Also closes contained branch ownership. */
  complete(): void {
    if (this.#sealed) return;
    this.#pending = undefined;
    this.#result = undefined;
    this.#sealed = true;
  }
}
