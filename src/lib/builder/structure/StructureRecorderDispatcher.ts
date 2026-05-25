/**
 * StructureRecorderDispatcher — Fans build-time structure events out to N
 * attached `StructureRecorder` instances.
 *
 * Mirrors `FlowRecorderDispatcher` (engine/narrative/) exactly:
 *
 *   - `recorders: StructureRecorder[]` — attach order preserved
 *   - per-event fire methods early-return when no recorders attached
 *     (zero-allocation fast path)
 *   - per-recorder try/catch isolates errors; one bad recorder cannot
 *     cascade into the chain build or sibling recorders
 *   - errors route to BOTH the dev-mode console warning (matches
 *     FlowRecorderDispatcher) AND a structured `buildErrors`
 *     accumulator so consumers can inspect failures post-build
 *   - spec payloads are NOT frozen at dispatch time — handlers must
 *     respect the `readonly` markers on event payload types (the
 *     builder still needs to mutate `spec.next` after the immediate
 *     `onStageAdded` fires; see `fireStageAdded` for the full note,
 *     and `StructureRecorder.ts` header "Spec mutation" for the
 *     trust-model implications)
 *
 * The dispatcher itself owns NO chart state. The builder owns the
 * dispatcher; events fire from the natural mutation points in
 * FlowChartBuilder (L7.3).
 */

import { isDevMode } from '../../scope/detectCircular.js';
import type { FlowChartSpec } from '../types.js';
import type {
  StructureDeciderCompleteEvent,
  StructureEdgeAddedEvent,
  StructureLoopEdgeAddedEvent,
  StructureRecorder,
  StructureStageAddedEvent,
  StructureSubflowMountedEvent,
} from './StructureRecorder.js';

/** Structured error captured when a recorder throws. Read post-build
 *  via `builder.getStructureBuildErrors()` — call on the BUILDER
 *  reference (NOT the chart returned by `.build()`). Capture the
 *  builder reference before `.build()` if you need post-build access. */
export interface StructureBuildError {
  /** Which recorder's handler threw. */
  readonly recorderId: string;
  /** Which event method (`'onStageAdded'`, `'onEdgeAdded'`, ...). */
  readonly method: string;
  /** Error message extracted from the thrown value. */
  readonly message: string;
  /** The original thrown value — `Error` instance or whatever the
   *  recorder threw. Useful when diagnosis needs a stack trace. */
  readonly error: unknown;
}

/**
 * Soft cap on the `errors[]` accumulator. Builds with thousands of
 * stages and a misbehaving recorder that throws on every event would
 * otherwise retain unbounded `{recorderId, method, message, error}`
 * records — each closing over the thrown value (often an Error with
 * a captured stack), preventing GC of any closure data the throw
 * captured. The cap is for diagnosis, not forensic completeness;
 * once exceeded, a single sentinel record signals truncation.
 */
const STRUCTURE_BUILD_ERRORS_CAP = 100;

export class StructureRecorderDispatcher {
  private recorders: StructureRecorder[] = [];
  private readonly errors: StructureBuildError[] = [];
  private _truncated = false;

  /** Attach a `StructureRecorder`. Multiple recorders with the same
   *  id are allowed; the convention is one id per logical concern. */
  attach(recorder: StructureRecorder): void {
    this.recorders.push(recorder);
  }

  /** Detach every recorder with the given id. */
  detach(id: string): void {
    this.recorders = this.recorders.filter((r) => r.id !== id);
  }

  /** Defensive copy of the attached recorders — used in tests + by
   *  tooling that wants to inspect what's registered. */
  getRecorders(): StructureRecorder[] {
    return [...this.recorders];
  }

  /** Find one recorder by id. */
  getRecorderById<T extends StructureRecorder = StructureRecorder>(id: string): T | undefined {
    return this.recorders.find((r) => r.id === id) as T | undefined;
  }

  /** Read accumulated errors from this build. Returns a defensive copy. */
  getErrors(): StructureBuildError[] {
    return [...this.errors];
  }

  // ── fire* methods — called by the builder at each event moment ─────

  fireStageAdded(event: StructureStageAddedEvent): void {
    if (this.recorders.length === 0) return;
    // NOTE: `event.spec` is NOT frozen here. `onStageAdded` fires
    // IMMEDIATELY when a spec node is added — the builder still needs
    // to mutate `spec.next` later (in the subsequent `addX` call).
    // Freezing here would break the builder. Handler mutation of
    // `event.spec` is documented as undefined behavior — see the
    // StructureRecorder type's JSDoc + readonly markers on the
    // event payload interface.
    for (const r of this.recorders) {
      try {
        r.onStageAdded?.(event);
      } catch (err) {
        this.recordError(r.id, 'onStageAdded', err);
      }
    }
  }

  fireEdgeAdded(event: StructureEdgeAddedEvent): void {
    if (this.recorders.length === 0) return;
    // No spec on this event — pass through.
    for (const r of this.recorders) {
      try {
        r.onEdgeAdded?.(event);
      } catch (err) {
        this.recordError(r.id, 'onEdgeAdded', err);
      }
    }
  }

  fireLoopEdgeAdded(event: StructureLoopEdgeAddedEvent): void {
    if (this.recorders.length === 0) return;
    for (const r of this.recorders) {
      try {
        r.onLoopEdgeAdded?.(event);
      } catch (err) {
        this.recordError(r.id, 'onLoopEdgeAdded', err);
      }
    }
  }

  fireDeciderComplete(event: StructureDeciderCompleteEvent): void {
    if (this.recorders.length === 0) return;
    for (const r of this.recorders) {
      try {
        r.onDeciderComplete?.(event);
      } catch (err) {
        this.recordError(r.id, 'onDeciderComplete', err);
      }
    }
  }

  fireSubflowMounted(event: StructureSubflowMountedEvent): void {
    if (this.recorders.length === 0) return;
    for (const r of this.recorders) {
      try {
        r.onSubflowMounted?.(event);
      } catch (err) {
        this.recordError(r.id, 'onSubflowMounted', err);
      }
    }
  }

  /**
   * Externally-callable error capture for events the builder fires
   * OUTSIDE the normal fire* fan-out path — specifically the seed
   * replay in `FlowChartBuilder.attachStructureRecorder()`, which
   * targets one specific recorder rather than every attached recorder.
   *
   * Same observability contract as the internal `recordError`:
   * accumulates on `getErrors()` AND logs in dev mode.
   */
  recordErrorForReplay(recorderId: string, method: string, err: unknown): void {
    this.recordError(recorderId, method, err);
  }

  // ── Internals ───────────────────────────────────────────────────────

  private recordError(recorderId: string, method: string, err: unknown): void {
    const e = err as { message?: unknown } | undefined;
    const message = typeof e?.message === 'string' ? e.message : String(err);
    // Soft cap to prevent unbounded growth + closure retention. Once
    // hit, push a single sentinel describing the truncation and drop
    // further records on the floor (still log in dev mode so the
    // consumer notices the spam at its source).
    if (this.errors.length < STRUCTURE_BUILD_ERRORS_CAP) {
      this.errors.push({ recorderId, method, message, error: err });
    } else if (!this._truncated) {
      this._truncated = true;
      this.errors.push({
        recorderId: '__truncated__',
        method: '__truncated__',
        message: `StructureRecorderDispatcher: error accumulator truncated at ${STRUCTURE_BUILD_ERRORS_CAP} entries; further errors suppressed.`,
        error: null,
      });
    }
    if (isDevMode()) {
      // eslint-disable-next-line no-console
      console.warn(
        `[footprint] StructureRecorderDispatcher: recorder "${recorderId}" threw in ${method}: ${message}. ` +
          'See builder.getStructureBuildErrors() for the full list.',
      );
    }
  }
}

/** Re-export the FlowChartSpec type for downstream type completeness. */
export type { FlowChartSpec };
