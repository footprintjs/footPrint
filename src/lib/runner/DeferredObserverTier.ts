/**
 * runner/DeferredObserverTier.ts — RFC-001 Blocks 6–9: the engine wiring of
 * the deferred-observer pipeline.
 *
 * Pattern:  Thin adapter between the executor's three observer channels and
 *           the PURE `observer-queue` module. The pure module stays
 *           engine-free (it imports nothing from the engine — the engine
 *           imports IT); this tier owns every engine-flavored concern:
 *             - the `isDevMode()`-gated, deduplicated `CaptureHooks.warn`
 *               binding (the dev-warn seam, RFC-001 §"Resolution");
 *             - routing `DeferredDispatcher.onError` into the existing
 *               recorder error channel (`onError` on sibling observers);
 *             - the capture TAPS — synthetic recorders placed on the
 *               existing inline dispatch lists so the three dispatch sites
 *               (`ScopeFacade._invokeHook`, `ScopeFacade.emitEvent`,
 *               `FlowRecorderDispatcher`) need NO per-site tier logic: a
 *               tap's hook body IS `dispatcher.capture(...)`, and because
 *               the tap sits in the same loop as inline recorders it sees
 *               exactly the post-redaction event object inline observers
 *               see — capture can never observe a pre-redaction value;
 *             - the terminal flush (Block 8) with honest stranding
 *               accounting, and the Block 9 stats surface.
 *
 * Role:     One instance per `FlowChartExecutor`, created LAZILY on the
 *           first `delivery: 'deferred'` attach (zero allocation when nobody
 *           opts in — mirrors the emit fast-path precedent). Holds the ONE
 *           `DeferredDispatcher` (one merged queue, total order across
 *           channels) plus the registry of deferred recorders.
 *
 * Delivery: a deferred recorder's hooks are invoked through the SAME
 * `invokeRecorderHook` helper the inline tier uses (RFC-001 §9 mitigation) —
 * one beat behind, with `envelope.payload` materialized per the capture
 * policy (`'summary'` default — bounded, reference-free; `'clone'` — full
 * structural copy, event-shape compatible with inline; `'ref'` — the live
 * event object, dev-warned).
 *
 * Channel filter: a registration remembers which channels would have
 * reached the recorder inline (scope-list recorders see `scope` + `emit`
 * envelopes; flow-list recorders see `flow` envelopes) and skips the rest —
 * same reach as the inline tier, one beat behind.
 */

import type { FlowRecorder } from '../engine/narrative/types.js';
import {
  type CaptureChannel,
  type CaptureEnvelope,
  type CapturePolicy,
  type DispatcherStats,
  type DrainResult,
  type OverflowPolicy,
  DeferredDispatcher,
} from '../observer-queue/index.js';
import {
  EMIT_RECORDER_EVENT_METHODS,
  FLOW_RECORDER_EVENT_METHODS,
  RECORDER_EVENT_METHODS,
} from '../recorder/CombinedRecorder.js';
import { invokeRecorderHook } from '../recorder/invokeHook.js';
import { isDevMode } from '../scope/detectCircular.js';
import type { ScopeRecorder } from '../scope/types.js';

/** Delivery tier for an attached observer (RFC-001). */
export type ObserverDelivery = 'inline' | 'deferred';

/**
 * Options bag accepted by every `attach*Recorder` call.
 *
 * `delivery: 'deferred'` opts the recorder into the bounded capture queue
 * ("one beat behind"); absent / `'inline'` keeps the historical synchronous
 * call — byte-identical to the pre-RFC path.
 *
 * The remaining fields configure the executor's ONE shared dispatcher and
 * are applied when the FIRST deferred attach creates it; later attaches
 * passing different values get a dev-mode warning and keep the original
 * configuration (one queue per executor — per-recorder queues would break
 * the total cross-channel order).
 */
export interface AttachRecorderOptions {
  /** `'deferred'` = capture → queue → next-checkpoint delivery. Default `'inline'`. */
  readonly delivery?: ObserverDelivery;
  /**
   * Payload materialization at capture time. `'summary'` (default) —
   * bounded, reference-free summary (the recorder receives a
   * `PayloadSummary`, NOT the original event shape); `'clone'` —
   * `structuredClone` of the event (event-shape compatible with inline;
   * degrades to `'summary'` with a dev-warn when unclonable); `'ref'` —
   * the live event reference (dev-warned; caller asserts immutability).
   */
  readonly capture?: CapturePolicy;
  /** Queue bound — default 10 000. */
  readonly maxQueue?: number;
  /** Overflow policy at `maxQueue` — default `'drop-oldest'`. */
  readonly overflow?: OverflowPolicy;
  /** `'sample'` overflow only — admit 1 in this many saturated arrivals. */
  readonly sampleEvery?: number;
  /** Per-checkpoint flush budget, ms (A1) — default 2; `Infinity` = full drain. */
  readonly flushBudgetMs?: number;
}

/**
 * The Block 9 observability surface — `snapshot.observerStats`. The A4
 * dispatcher stats plus the terminal-flush stranding count from Block 8.
 * Present on `RuntimeSnapshot` only when a deferred observer was attached.
 */
export interface ObserverStats extends DispatcherStats {
  /**
   * Envelopes still queued when a terminal flush hit its runaway-cascade
   * round cap (Block 8). `0` in any sane run — a non-zero value means a
   * listener kept enqueueing work at end-of-run and delivery was cut off
   * (also dev-warned at the moment it happened). Never silent.
   */
  readonly terminalStranded: number;
}

/** Result shape of `executor.drainObservers()` — see `DrainResult`. */
export type ObserverDrainResult = DrainResult;

/** Well-known ids of the synthetic capture taps (internal, documented for debugging). */
export const DEFERRED_SCOPE_TAP_ID = '__deferred-scope-tap__';
export const DEFERRED_FLOW_TAP_ID = '__deferred-flow-tap__';

/** Channel reach of the scope-recorder list (scope events + emit events). */
const SCOPE_LIST_CHANNELS: readonly CaptureChannel[] = ['scope', 'emit'];
/** Channel reach of the flow-recorder list. */
const FLOW_LIST_CHANNELS: readonly CaptureChannel[] = ['flow'];

/** Dispatcher-level options snapshot, kept for conflict detection. */
interface AppliedDispatcherConfig {
  readonly capture?: CapturePolicy;
  readonly maxQueue?: number;
  readonly overflow?: OverflowPolicy;
  readonly sampleEvery?: number;
  readonly flushBudgetMs?: number;
}

interface DeferredRegistration {
  readonly recorder: ScopeRecorder | FlowRecorder;
  /** Which envelope channels reach this recorder (inline-tier parity). */
  readonly channels: Set<CaptureChannel>;
}

/** Map an envelope method onto the scope error-event `operation` vocabulary
 *  (same mapping `ScopeFacade._invokeHook` uses for inline failures). */
function operationFor(method: string): 'read' | 'write' | 'commit' {
  if (method === 'onRead') return 'read';
  if (method === 'onCommit') return 'commit';
  return 'write';
}

export class DeferredObserverTier {
  private readonly dispatcher: DeferredDispatcher;
  private readonly registrations = new Map<string, DeferredRegistration>();
  private readonly appliedConfig: AppliedDispatcherConfig;
  /** Dedup memory for the dev-warn seam (one warning per unique message). */
  private readonly warnedMessages = new Set<string>();
  private terminalStranded = 0;

  constructor(options?: AttachRecorderOptions) {
    this.appliedConfig = {
      capture: options?.capture,
      maxQueue: options?.maxQueue,
      overflow: options?.overflow,
      sampleEvery: options?.sampleEvery,
      flushBudgetMs: options?.flushBudgetMs,
    };
    this.dispatcher = new DeferredDispatcher({
      maxQueue: options?.maxQueue,
      overflow: options?.overflow,
      sampleEvery: options?.sampleEvery,
      capturePolicy: options?.capture,
      flushBudgetMs: options?.flushBudgetMs,
      // The dev-warn seam (RFC-001 §"Resolution: the dev-warn seam"): the
      // pure module invokes `warn` on every 'ref' capture and every 'clone'
      // degradation; the tier binds it to the central isDevMode() flag and
      // dedupes by message so a hot loop cannot spam the console.
      hooks: { warn: (message) => this.devWarnDeduped(message) },
      // Listener failures (sync throws AND async rejections) route into the
      // existing recorder error channel — see routeListenerError.
      onError: (error, ctx) => this.routeListenerError(error, ctx.listenerId, ctx.envelope, ctx.phase),
    });
  }

  // ── Registry ─────────────────────────────────────────────────────────────

  /**
   * Register a recorder for deferred delivery on the scope-list channels
   * (`scope` + `emit`) and/or the flow channel. Idempotent by id — same id
   * replaces the recorder object; channel lists MERGE across calls (same as
   * the inline tier, where `attachScopeRecorder(x)` + `attachFlowRecorder(x)`
   * lands `x` on both lists). Later attaches passing dispatcher-level
   * options that differ from the first attach's configuration keep the
   * original config and dev-warn.
   */
  register(
    recorder: ScopeRecorder | FlowRecorder,
    lists: { scope?: boolean; flow?: boolean },
    options?: AttachRecorderOptions,
  ): void {
    this.warnOnConfigConflict(recorder.id, options);
    const channels = this.registrations.get(recorder.id)?.channels ?? new Set<CaptureChannel>();
    if (lists.scope) for (const c of SCOPE_LIST_CHANNELS) channels.add(c);
    if (lists.flow) for (const c of FLOW_LIST_CHANNELS) channels.add(c);
    this.registrations.set(recorder.id, { recorder, channels });
    this.dispatcher.addListener(recorder.id, (envelope) => {
      const registration = this.registrations.get(recorder.id);
      if (!registration || !registration.channels.has(envelope.channel)) return;
      // SAME invoke helper as the inline tier (RFC-001 §9 mitigation) — a
      // returned Promise lands in the dispatcher's inflight set.
      return invokeRecorderHook(recorder, envelope.method, envelope.payload) as void | Promise<void>;
    });
  }

  /**
   * Remove the given channel lists from a registration (mirrors the inline
   * tier, where `detachScopeRecorder` / `detachFlowRecorder` each clear one
   * list). When no channels remain, the listener is fully removed.
   */
  removeFromLists(id: string, lists: { scope?: boolean; flow?: boolean }): void {
    const registration = this.registrations.get(id);
    if (!registration) return;
    if (lists.scope) for (const c of SCOPE_LIST_CHANNELS) registration.channels.delete(c);
    if (lists.flow) for (const c of FLOW_LIST_CHANNELS) registration.channels.delete(c);
    if (registration.channels.size === 0) {
      this.registrations.delete(id);
      this.dispatcher.removeListener(id);
    }
  }

  /** True when `id` is registered for deferred delivery (any channel). */
  has(id: string): boolean {
    return this.registrations.has(id);
  }

  /** Deferred recorders whose reach includes the scope list (scope+emit). */
  scopeListRecorders(): ScopeRecorder[] {
    return this.byChannel('scope') as ScopeRecorder[];
  }

  /** Deferred recorders whose reach includes the flow channel. */
  flowListRecorders(): FlowRecorder[] {
    return this.byChannel('flow') as FlowRecorder[];
  }

  /** Reset deferred recorders before a fresh run (same contract as inline). */
  clearRecorders(): void {
    for (const { recorder } of this.registrations.values()) {
      (recorder as { clear?: () => void }).clear?.();
    }
  }

  // ── Capture taps (Block 7) ───────────────────────────────────────────────

  /**
   * Build the synthetic scope-channel tap — a `ScopeRecorder` placed on the
   * normal scope-recorder list whose hooks capture into the queue. Built
   * fresh per traverser so it reflects the current registrations. Only
   * methods some deferred recorder actually implements are present (no
   * wasted captures). Returns `undefined` when nothing is registered for
   * the scope list.
   *
   * Redaction ordering: the tap is invoked from the SAME loops as inline
   * recorders (`_invokeHook` / `emitEvent`), which receive events AFTER the
   * redaction decision — so a captured payload can never contain a
   * pre-redaction value the inline tier would not have seen.
   */
  buildScopeTap(): ScopeRecorder | undefined {
    const recorders = this.scopeListRecorders();
    if (recorders.length === 0) return undefined;
    const tap: Record<string, unknown> = { id: DEFERRED_SCOPE_TAP_ID };
    for (const method of RECORDER_EVENT_METHODS) {
      if (!this.anyImplements(recorders, method)) continue;
      tap[method] = (event: unknown) => this.captureScopeEvent('scope', method, event);
    }
    for (const method of EMIT_RECORDER_EVENT_METHODS) {
      if (!this.anyImplements(recorders, method)) continue;
      tap[method] = (event: unknown) => this.captureScopeEvent('emit', method, event);
    }
    return tap as unknown as ScopeRecorder;
  }

  /**
   * Build the synthetic flow-channel tap — a `FlowRecorder` appended to the
   * flow-recorders list handed to the traverser. Same contract as
   * {@link buildScopeTap}.
   */
  buildFlowTap(): FlowRecorder | undefined {
    const recorders = this.flowListRecorders();
    if (recorders.length === 0) return undefined;
    const tap: Record<string, unknown> = { id: DEFERRED_FLOW_TAP_ID };
    for (const method of FLOW_RECORDER_EVENT_METHODS) {
      if (!this.anyImplements(recorders, method)) continue;
      tap[method] = (event: unknown) => this.captureFlowEvent(method, event);
    }
    return tap as unknown as FlowRecorder;
  }

  /**
   * Direct capture for executor-synthesized events that bypass the dispatch
   * sites (e.g. the synthetic `onResume` the executor fires on resume).
   */
  capture(channel: CaptureChannel, method: string, runtimeStageId: string, runId: string, payload: unknown): void {
    this.dispatcher.capture({ channel, method, runtimeStageId, runId, payload });
  }

  // ── Terminal flush + drain (Block 8) ─────────────────────────────────────

  /**
   * Synchronously deliver everything still queued — called by the executor
   * at the OUTERMOST run boundary (resolve, reject, pause), BEFORE `run()`
   * returns / rethrows / the checkpoint becomes available. Inspects
   * `flushSync`'s `remaining` (reviewer N1): `flushSync` already loops
   * snapshot rounds up to its runaway-cascade cap, so a non-zero remainder
   * means a pathological self-enqueueing listener — counted in
   * `observerStats.terminalStranded` and dev-warned, never silent.
   */
  terminalFlush(): void {
    const { remaining } = this.dispatcher.flushNow();
    if (remaining > 0) {
      this.terminalStranded += remaining;
      if (isDevMode()) {
        // eslint-disable-next-line no-console
        console.warn(
          `[footprintjs] deferred observers: terminal flush hit the runaway-cascade cap with ${remaining} ` +
            'event(s) still queued — a listener kept enqueueing during the flush. The stranded count is ' +
            'surfaced on snapshot.observerStats.terminalStranded.',
        );
      }
    }
  }

  /**
   * Flush the backlog, then settle async listener continuations under a
   * deadline — the serverless / graceful-shutdown pattern (RFC-001 §11).
   */
  drain(opts?: { timeoutMs?: number }): Promise<ObserverDrainResult> {
    return this.dispatcher.drain(opts);
  }

  // ── Stats (Block 9) ──────────────────────────────────────────────────────

  /** The `snapshot.observerStats` payload — A4 stats + Block 8 stranding. */
  getStats(): ObserverStats {
    return { ...this.dispatcher.getStats(), terminalStranded: this.terminalStranded };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private byChannel(channel: CaptureChannel): Array<ScopeRecorder | FlowRecorder> {
    const out: Array<ScopeRecorder | FlowRecorder> = [];
    for (const { recorder, channels } of this.registrations.values()) {
      if (channels.has(channel)) out.push(recorder);
    }
    return out;
  }

  /** Normal property lookup — invocation parity with the inline tier. */
  private anyImplements(recorders: Array<ScopeRecorder | FlowRecorder>, method: string): boolean {
    return recorders.some((r) => typeof (r as unknown as Record<string, unknown>)[method] === 'function');
  }

  /** Scope/emit events carry their own ids (`runtimeStageId` + `pipelineId`). */
  private captureScopeEvent(channel: CaptureChannel, method: string, event: unknown): void {
    const e = event as { runtimeStageId?: string; pipelineId?: string } | undefined;
    this.dispatcher.capture({
      channel,
      method,
      runtimeStageId: e?.runtimeStageId ?? '',
      runId: e?.pipelineId ?? '',
      payload: event,
    });
  }

  /** Flow events carry ids on `traversalContext` (absent on a few events). */
  private captureFlowEvent(method: string, event: unknown): void {
    const ctx = (event as { traversalContext?: { runtimeStageId?: string; runId?: string } } | undefined)
      ?.traversalContext;
    this.dispatcher.capture({
      channel: 'flow',
      method,
      runtimeStageId: ctx?.runtimeStageId ?? '',
      runId: ctx?.runId ?? '',
      payload: event,
    });
  }

  /**
   * Route a deferred listener failure into the existing recorder error
   * channel: every OTHER registered observer (deferred siblings first, in
   * registration order) receives a scope-shaped `onError` event — the same
   * contract the inline tier honors when a recorder throws mid-dispatch.
   * The error sink must never become an error source: sink throws are
   * swallowed (isolation is absolute).
   */
  private routeListenerError(
    error: unknown,
    listenerId: string,
    envelope: CaptureEnvelope,
    phase: 'sync' | 'async',
  ): void {
    const hashIdx = envelope.runtimeStageId.lastIndexOf('#');
    const errorEvent = {
      stageName: '',
      stageId: hashIdx >= 0 ? envelope.runtimeStageId.slice(0, hashIdx) : envelope.runtimeStageId,
      runtimeStageId: envelope.runtimeStageId,
      pipelineId: envelope.runId,
      timestamp: Date.now(),
      error: error instanceof Error ? error : new Error(String(error)),
      operation: operationFor(envelope.method),
      channel: 'scope' as const,
    };
    for (const [id, { recorder }] of this.registrations) {
      if (id === listenerId) continue;
      try {
        invokeRecorderHook(recorder, 'onError', errorEvent);
      } catch {
        // Swallow — same rule as DeferredDispatcher.safeOnError.
      }
    }
    if (isDevMode()) {
      // eslint-disable-next-line no-console
      console.warn(
        `[footprintjs] deferred observer '${listenerId}' failed (${phase}) handling ` +
          `${envelope.channel}.${envelope.method} (seq ${envelope.seq}): ${String(error)}`,
      );
    }
  }

  /** Dispatcher-level options are first-attach-wins; differing later values dev-warn. */
  private warnOnConfigConflict(recorderId: string, options?: AttachRecorderOptions): void {
    if (!options) return;
    const conflicts: string[] = [];
    const requested: AppliedDispatcherConfig = {
      capture: options.capture,
      maxQueue: options.maxQueue,
      overflow: options.overflow,
      sampleEvery: options.sampleEvery,
      flushBudgetMs: options.flushBudgetMs,
    };
    for (const key of Object.keys(requested) as Array<keyof AppliedDispatcherConfig>) {
      if (requested[key] !== undefined && requested[key] !== this.appliedConfig[key]) {
        conflicts.push(String(key));
      }
    }
    if (conflicts.length > 0) {
      this.devWarnDeduped(
        `[footprintjs] attach '${recorderId}': the executor's deferred-observer queue was already ` +
          `configured by the first deferred attach — ignoring differing option(s): ${conflicts.join(', ')}. ` +
          'One executor has ONE merged queue; configure it on the first deferred attach.',
      );
    }
  }

  /** `isDevMode()`-gated, deduplicated warner — the bound warn seam. */
  private devWarnDeduped(message: string): void {
    if (!isDevMode()) return;
    if (this.warnedMessages.has(message)) return;
    this.warnedMessages.add(message);
    // eslint-disable-next-line no-console
    console.warn(message);
  }
}
