/**
 * runner/recordSink.ts — the run's side of the crash-safe record (design §3.5, packet P6).
 *
 * foottrace owns the port (`RecordSink`, `foottrace/write`): a log built with a sink hands it every entry AS IT
 * LANDS — `opened`, `commit`, `note`, `closed` — and counts what the sink did not take. This file is what the
 * EXECUTOR adds around an app's adapter, one {@link RunRecord} per run:
 *
 *   - THE ONE LAW, before any byte leaves: the `opened` base is the run's served form of it (the redaction rule's
 *     `retainState`, the mirror's seed — so a policy key seeded by `initialContext` or a checkpoint never reaches
 *     the sink), and the `opened` / `closed` meta are boundary records (`retainBoundary`). A commit is the log's own
 *     bundle, already scrubbed at commit; an attempt note carries the served `AttemptRecord` (no `raw`).
 *   - ACCOUNTING: every entry handed to the adapter is counted, every loss too (`getSnapshot().sink`), with a
 *     dev-mode warning on the first loss of a run. The adapter's own `onFailure` hears a dispatched entry's loss
 *     with that same served entry and a served error, isolated. A refusal before dispatch is counted without
 *     forwarding Foottrace's unserved entry.
 *   - THE FAILURE MODE (owner ruling Q3): `'report'` (default) — the run goes on; `'fail'` — the first lost entry
 *     aborts the run's signal with a {@link RecordSinkError}, and a run that finished with a loss rejects with it.
 *   - FLUSH: `'auto'` (default) — `run()` / `resume()` await the adapter's `flush()` after the closing entry;
 *     `'manual'` — the app calls `executor.flushRecord()`.
 *
 * Every adapter method is called synchronously from the log; whatever the adapter throws or rejects with is the
 * log's to count (`EventLog · sinkFailures`), never the run's — so nothing here throws to the engine.
 */

import type { Meta } from 'foottrace';
import type { RecordEntry, RecordSink } from 'foottrace/write';
import { LOG_PLACEHOLDER } from 'foottrace/write';

import type { CaptureHistoryOptions, CaptureHistoryStatus } from '../capture/historyTypes.js';
import { settleOnce } from '../capture/sinkSettlement.js';
import { isDevMode } from '../devMode.js';
import { extractErrorInfo, thrownText } from '../errors/errorInfo.js';
import type { RedactionRule } from '../memory/redaction.js';
import { SCOPE_PLACEHOLDER } from '../memory/redaction.js';
import type { RecordSinkStats } from './ExecutionRuntime.js';

/** What a lost entry does to the run: `'report'` counts it and goes on; `'fail'` fails the run. */
export type RecordSinkFailureMode = 'report' | 'fail';

/** When the adapter's `flush()` runs: after each run's closing entry (`'auto'`), or when the app asks. */
export type RecordSinkFlushMode = 'auto' | 'manual';

/**
 * The executor's `sink` option in its long form. The short form is the adapter itself.
 *
 * @example
 * ```typescript
 * new FlowChartExecutor(chart, { sink: { adapter: fileSink('/var/footprint/run.jsonl'), onFailure: 'fail' } });
 * ```
 */
export interface RecordSinkOptions {
  /** Where the entries go — `fileSink(path)` (`footprintjs/sinks`), `memorySink()` (`foottrace/write`), or yours. */
  readonly adapter: RecordSink;
  /** `'report'` (default): a lost entry is counted and the run goes on. `'fail'`: the first one fails the run. */
  readonly onFailure?: RecordSinkFailureMode;
  /** `'auto'` (default): `run()` awaits the adapter's `flush()` after the closing entry. `'manual'`: `flushRecord()`. */
  readonly flush?: RecordSinkFlushMode;
  /** Opt-in capture evidence and explicit host acknowledgement; ordinary flush never implies durability. */
  readonly capture?: CaptureHistoryOptions;
}

/** The executor's `sink` option: an adapter, or {@link RecordSinkOptions}. */
export type RecordSinkOption = RecordSink | RecordSinkOptions;

/** What `executor.flushRecord()` resolves with — the `drainObservers` shape. */
export interface RecordFlushResult {
  /** The adapter's flush finished (or there was nothing to flush). */
  readonly done: boolean;
  /** The adapter's flush threw or rejected — counted on `getSnapshot().sink`. */
  readonly failed: boolean;
  /** The flush had not settled when `timeoutMs` ran out. */
  readonly pending: boolean;
}

/**
 * A run with `sink: { onFailure: 'fail' }` lost an entry: the record the app asked to be kept is not whole.
 * `cause` is the adapter's own error.
 */
export class RecordSinkError extends Error {
  override readonly name = 'RecordSinkError';
  constructor(message: string, readonly cause: unknown) {
    super(message);
  }
}

/** The option resolved once, at construction. */
export interface ResolvedRecordSink {
  readonly adapter: RecordSink;
  readonly onFailure: RecordSinkFailureMode;
  readonly flush: RecordSinkFlushMode;
  readonly capture?: CaptureHistoryOptions;
}

const METHODS = ['opened', 'commit', 'note', 'closed'] as const;

interface SinkErrorView {
  readonly text: string;
  readonly error: unknown;
  readonly masked: boolean;
  readonly rule?: RedactionRule;
}

interface InvocationFailure {
  readonly entry: RecordEntry;
  readonly cause: unknown;
  readonly view: SinkErrorView;
}

function isAdapter(value: unknown): value is RecordSink {
  if (value === null || typeof value !== 'object') return false;
  return METHODS.every((m) => typeof (value as Record<string, unknown>)[m] === 'function');
}

/**
 * Resolve the executor's `sink` option, or refuse it with a `TypeError` naming what is wrong — a wiring mistake
 * the app makes once, so it fails at construction, never mid-run.
 */
export function resolveRecordSink(option: unknown): ResolvedRecordSink | undefined {
  if (option === undefined) return undefined;
  if (isAdapter(option)) return { adapter: option, onFailure: 'report', flush: 'auto' };
  if (option !== null && typeof option === 'object' && Object.hasOwn(option, 'adapter')) {
    const { adapter, onFailure = 'report', flush = 'auto', capture } = option as Partial<RecordSinkOptions>;
    if (!isAdapter(adapter)) {
      throw new TypeError('FlowChartExecutor: sink.adapter must be a RecordSink (opened, commit, note, closed)');
    }
    if (onFailure !== 'report' && onFailure !== 'fail') {
      throw new TypeError("FlowChartExecutor: sink.onFailure must be 'report' or 'fail'");
    }
    if (flush !== 'auto' && flush !== 'manual') {
      throw new TypeError("FlowChartExecutor: sink.flush must be 'auto' or 'manual'");
    }
    if (capture !== undefined) {
      if (!capture || typeof capture.acknowledge !== 'function')
        throw new TypeError('sink.capture requires acknowledge');
      for (const [key, max] of [
        ['maxBytes', 8 * 1024 * 1024],
        ['timeoutMs', 30_000],
      ] as const) {
        const value = capture[key];
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > max))
          throw new RangeError(`sink.capture.${key} must be a positive whole number at most ${max}`);
      }
    }
    const fixedCapture =
      capture &&
      Object.freeze({
        acknowledge: capture.acknowledge.bind(capture),
        ...(capture.maxBytes !== undefined && { maxBytes: capture.maxBytes }),
        ...(capture.timeoutMs !== undefined && { timeoutMs: capture.timeoutMs }),
      });
    return { adapter, onFailure, flush, ...(fixedCapture && { capture: fixedCapture }) };
  }
  throw new TypeError(
    'FlowChartExecutor: sink must be a RecordSink (opened, commit, note, closed) or { adapter, onFailure?, flush? }',
  );
}

/**
 * One run's record sink: the sink every log of the run writes to (root and mounts), its accounting and its
 * failure mode. A same-executor resume keeps it (the root log goes on); a fresh run makes a new one.
 */
export class RunRecord {
  /** Hand this to every `EventLog` of the run. */
  readonly sink: RecordSink;
  private entries = 0;
  private failed = 0;
  private lastError?: string;
  private warned = false;
  private rule?: RedactionRule;
  /** Aborted at the first loss under `'fail'` — composed into the leg's signal; fresh per leg ({@link beginLeg}). */
  private stopper?: AbortController;
  private failure?: RecordSinkError;
  private capturePending = 0;
  private captureStatus?: CaptureHistoryStatus;
  /** Opaque error identities only: no raw entry or adapter error is enumerable on the transport error. */
  private readonly invocationFailures = new WeakMap<object, InvocationFailure>();

  constructor(private readonly resolved: ResolvedRecordSink) {
    if (resolved.onFailure === 'fail') this.stopper = new AbortController();
    const adapter = resolved.adapter;
    const handed = (): void => {
      this.entries += 1;
    };
    this.sink = {
      opened: (entry) => {
        handed();
        const rule = this.rule;
        const served = {
          ...entry,
          initialState: rule ? rule.retainState(entry.initialState, LOG_PLACEHOLDER) : entry.initialState,
          ...(entry.meta === undefined ? {} : { meta: this.serve(entry.meta) }),
        };
        return this.invoke({ ...served, kind: 'opened' }, () => adapter.opened(served), rule);
      },
      commit: (entry) => {
        handed();
        return this.invoke({ ...entry, kind: 'commit' }, () => adapter.commit(entry), this.rule);
      },
      note: (entry) => {
        handed();
        return this.invoke(
          { address: entry.address, at: entry.at, kind: 'note', note: entry.kind, data: entry.data },
          () => adapter.note(entry),
          this.rule,
        );
      },
      closed: (entry) => {
        handed();
        const served = { ...entry, ...(entry.meta === undefined ? {} : { meta: this.serve(entry.meta) }) };
        return this.invoke({ ...served, kind: 'closed' }, () => adapter.closed(served), this.rule);
      },
      onFailure: (failure) => {
        const invocation =
          failure.error !== null && (typeof failure.error === 'object' || typeof failure.error === 'function')
            ? this.invocationFailures.get(failure.error)
            : undefined;
        // Before admission (e.g. a meta-copy refusal), no dispatched served entry exists. Count the loss and
        // apply the failure mode, but never hand the adapter Foottrace's original, unserved entry.
        if (invocation === undefined) this.lost(failure.error, undefined, this.errorView(failure.error, this.rule));
        else this.lost(invocation.cause, invocation.entry, invocation.view);
      },
    };
  }

  /** Capture the served entry now; an asynchronous failure keeps this leg's rule, not a later resume's rule. */
  private invoke(entry: RecordEntry, call: () => unknown, rule: RedactionRule | undefined): unknown {
    const failed = (cause: unknown): never => {
      const envelope = new Error('record sink: adapter invocation failed');
      this.invocationFailures.set(envelope, { entry, cause, view: this.errorView(cause, rule) });
      throw envelope;
    };
    try {
      const returned = call();
      // Void adapters keep their synchronous path; only an object/function can be a thenable. settleOnce
      // observes native promises through Promise.prototype.then and guards hostile thenables too.
      if (returned === null || (typeof returned !== 'object' && typeof returned !== 'function')) return returned;
      if (!this.resolved.capture) return settleOnce(returned, () => undefined, failed);
      this.capturePending++;
      return settleOnce(
        returned,
        () => {
          this.capturePending--;
        },
        (cause) => {
          this.capturePending--;
          return failed(cause);
        },
      );
    } catch (cause) {
      return failed(cause);
    }
  }

  /** A sink error is the diagnostic errors.recordSinkError; raw causes belong only to the caller's exception. */
  private errorView(error: unknown, rule: RedactionRule | undefined): SinkErrorView {
    const text = thrownText(error);
    const retained = rule
      ? rule.retainStageError(error, text, rule.retainDiagnostic(['errors', 'recordSinkError'], text))
      : { message: text, structuredError: extractErrorInfo(error) };
    const served = { ...retained.structuredError };
    Reflect.deleteProperty(served, 'raw');
    return {
      text: retained.message,
      error: served,
      masked: retained.message !== text || retained.structuredError.raw !== error,
      rule,
    };
  }

  /**
   * A same-executor resume starts a new leg on the same record: the counts go on (one log, one record), but the
   * failure mode is the LEG's — a loss in an earlier leg (which already failed that leg) does not stop this one —
   * and the dev-mode warning may fire again.
   */
  beginLeg(): void {
    if (this.resolved.onFailure === 'fail') this.stopper = new AbortController();
    this.failure = undefined;
    this.warned = false;
    this.captureStatus = undefined;
  }

  /** The leg's redaction rule — a resume builds a new one; the next `opened` / `closed` is served under it. */
  useRule(rule: RedactionRule | undefined): void {
    this.rule = rule;
  }

  /** Aborts at the first loss under `onFailure: 'fail'`; absent otherwise. */
  get stopSignal(): AbortSignal | undefined {
    return this.stopper?.signal;
  }

  get flushMode(): RecordSinkFlushMode {
    return this.resolved.flush;
  }

  /** The loss that fails the run under `'fail'`; absent while nothing was lost (and always under `'report'`). */
  get fatal(): RecordSinkError | undefined {
    return this.failure;
  }

  stats(): RecordSinkStats {
    return {
      entries: this.entries,
      failed: this.failed,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      ...(this.captureStatus && { capture: this.captureStatus }),
    };
  }

  get captureOptions(): CaptureHistoryOptions | undefined {
    return this.resolved.capture;
  }

  get pendingCaptureDeliveries(): number {
    return this.capturePending;
  }

  captureResult(result: CaptureHistoryStatus): void {
    this.captureStatus = Object.freeze(result);
  }

  /** Same served seed as opened; a history digest never sees a seeded policy secret. */
  captureInitialState(state: Record<string, unknown>): Record<string, unknown> {
    return this.rule ? (this.rule.retainState(state, LOG_PLACEHOLDER) as Record<string, unknown>) : state;
  }

  /**
   * Await the adapter's `flush()`, at most `timeoutMs` when given. A flush that throws or rejects is a loss
   * (counted, and fatal under `'fail'`); one still running at the deadline is `pending` and keeps running — and,
   * with `pendingIsLoss` (the run's own flush), counted as a loss too, so a flush that never settles cannot hold a
   * run open, and cannot pass for one that landed. Nothing here throws: a hostile adapter (a throwing `flush`
   * getter, a promise with its own `then`) is a loss, never the run's error.
   */
  async flush(timeoutMs?: number, pendingIsLoss = false): Promise<RecordFlushResult> {
    const adapter = this.resolved.adapter;
    const rule = this.rule;
    let settled: Promise<RecordFlushResult>;
    let givenUp = false; // a flush already counted as a loss at the deadline is not counted again when it rejects
    try {
      const flush: unknown = adapter.flush; // read once: a getter runs once, inside the guard
      if (typeof flush !== 'function') return { done: true, failed: false, pending: false };
      settled = settleOnce(
        flush.call(adapter),
        (): RecordFlushResult => ({ done: true, failed: false, pending: false }),
        (error): RecordFlushResult => {
          if (!givenUp) this.lost(error, undefined, this.errorView(error, rule));
          return { done: false, failed: true, pending: false };
        },
      );
    } catch (error) {
      this.lost(error, undefined, this.errorView(error, rule));
      return { done: false, failed: true, pending: false };
    }
    if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return settled;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Promise<RecordFlushResult>((resolve) => {
      timer = setTimeout(() => resolve({ done: false, failed: false, pending: true }), Math.max(0, timeoutMs));
    });
    try {
      const result = await Promise.race([settled, pending]);
      if (result.pending && pendingIsLoss) {
        givenUp = true;
        const error = new Error(`record sink: flush() did not settle within ${Math.max(0, timeoutMs)}ms`);
        this.lost(error, undefined, this.errorView(error, rule));
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The meta as served: a boundary record, scrubbed by key name at every depth (an inert rule copies nothing). */
  serve(meta: Meta): Meta {
    return this.rule ? this.rule.retainBoundary(meta, LOG_PLACEHOLDER) : meta;
  }

  /** One loss: counted, warned once per run, told with a safe dispatched entry when available, fatal under 'fail'. */
  private lost(error: unknown, entry: RecordEntry | undefined, view: SinkErrorView): void {
    this.failed += 1;
    const text = view.text;
    this.lastError = text;
    if (isDevMode() && !this.warned) {
      this.warned = true;
      // eslint-disable-next-line no-console
      console.warn(
        `[footprint] record sink: an entry was not stored (${text}). The run goes on; ` +
          'getSnapshot().sink counts every loss.',
      );
    }
    // The failure mode first: nothing the adapter's own listener does can skip it.
    if (this.stopper !== undefined && this.failure === undefined) {
      this.failure = new RecordSinkError(`record sink: an entry was not stored — ${text}`, error);
      if (view.masked) {
        // The caller keeps the real cause, but observers of this new wrapper must inherit its remembered mask.
        view.rule?.retainStageError(this.failure, this.failure.message, SCOPE_PLACEHOLDER);
        if (this.rule !== view.rule) this.rule?.retainStageError(this.failure, this.failure.message, SCOPE_PLACEHOLDER);
      }
      this.stopper.abort(this.failure);
    }
    if (entry !== undefined) tellAdapter(this.resolved.adapter, { entry, error: view.error });
  }
}

/** The adapter's own `onFailure`, isolated: a throwing getter, a throw or a rejection there changes nothing. */
function tellAdapter(adapter: RecordSink, failure: { readonly entry: RecordEntry; readonly error: unknown }): void {
  try {
    const listener: unknown = adapter.onFailure;
    if (typeof listener !== 'function') return;
    settleOnce(
      listener.call(adapter, failure),
      () => undefined,
      () => undefined,
    );
  } catch {
    // A listener that fails is the adapter's own business: the loss is already counted.
  }
}
