/**
 * attach — who observes a run, and how they reach it (F9).
 *
 * `RunObservers` is the executor's ONE register of observers: the built-in
 * narrative recorder, the inline scope and flow lists, and the deferred tier
 * (RFC-001). The executor's `attach*Recorder` family delegates here; each leg
 * (`run()` / `resume()`) asks it for the composed scope factory and the flow
 * recorder list it hands the traverser.
 *
 * Laws kept here:
 *   - an id lives on exactly ONE delivery tier per list — re-attaching the
 *     same id SWAPS tiers, never double delivery;
 *   - every attach is idempotent by `id` (replace, never duplicate);
 *   - emit recorders ride the SCOPE list (`ScopeFacade` dispatches `onEmit`
 *     from the same per-stage list as `onRead`/`onWrite`);
 *   - a flow attach turns the narrative on (the flow channel needs it).
 */

import { isDevMode } from '../devMode.js';
import type { CombinedNarrativeRecorderOptions } from '../engine/narrative/CombinedNarrativeRecorder.js';
import { CombinedNarrativeRecorder } from '../engine/narrative/CombinedNarrativeRecorder.js';
import type { FlowRecorder } from '../engine/narrative/types.js';
import type { ScopeFactory } from '../engine/types.js';
import type { CombinedRecorder } from '../recorder/CombinedRecorder.js';
import { hasEmitRecorderMethods, hasFlowRecorderMethods, hasRecorderMethods } from '../recorder/CombinedRecorder.js';
import type { ScopeRuntimeTarget } from '../scope/runtime.js';
import { requireScopeRuntime } from '../scope/runtime.js';
import type { RedactionPolicy, ScopeRecorder } from '../scope/types.js';
import { type AttachRecorderOptions, DeferredObserverTier } from './DeferredObserverTier.js';

/** A step applied to every stage scope right after the base factory makes it. */
type ScopeModifier = (target: ScopeRuntimeTarget) => void;

export class RunObservers {
  narrativeEnabled = false;
  narrativeOptions?: CombinedNarrativeRecorderOptions;
  /** The built-in narrative recorder of the current leg (kept across a resume so it accumulates). */
  combinedRecorder: CombinedNarrativeRecorder | undefined;
  flowRecorders: FlowRecorder[] = [];
  scopeRecorders: ScopeRecorder[] = [];
  /**
   * RFC-001 deferred-observer wiring — created LAZILY on the first
   * `delivery: 'deferred'` attach. `undefined` for every executor that never
   * opts in: zero allocation, zero per-event cost, byte-identical behavior
   * (the emit fast-path precedent).
   */
  deferredTier?: DeferredObserverTier;

  enableNarrative(options?: CombinedNarrativeRecorderOptions): void {
    this.narrativeEnabled = true;
    if (options) this.narrativeOptions = options;
  }

  attachScope(recorder: ScopeRecorder, options?: AttachRecorderOptions): void {
    // Tier swap, both directions: an id lives on exactly ONE tier per list.
    this.scopeRecorders = this.scopeRecorders.filter((r) => r.id !== recorder.id);
    if (options?.delivery === 'deferred') {
      this.ensureDeferredTier(options).register(recorder, { scope: true }, options);
      return;
    }
    this.deferredTier?.removeFromLists(recorder.id, { scope: true });
    this.scopeRecorders.push(recorder);
  }

  attachFlow(recorder: FlowRecorder, options?: AttachRecorderOptions): void {
    // Tier swap, both directions: an id lives on exactly ONE tier per list.
    this.flowRecorders = this.flowRecorders.filter((r) => r.id !== recorder.id);
    this.narrativeEnabled = true;
    if (options?.delivery === 'deferred') {
      this.ensureDeferredTier(options).register(recorder, { flow: true }, options);
      return;
    }
    this.deferredTier?.removeFromLists(recorder.id, { flow: true });
    this.flowRecorders.push(recorder);
  }

  /**
   * Route a recorder to every channel it has OWN event methods for (see
   * `hasRecorderMethods` — prototype-chain methods are ignored on purpose,
   * against `Object.prototype` pollution). Idempotent by `id` across ALL
   * channels: a combined attach replaces a single-channel registration of the
   * same id on whichever channel(s) the recorder has methods for.
   */
  attachCombined(recorder: CombinedRecorder, options?: AttachRecorderOptions): void {
    const hasData = hasRecorderMethods(recorder);
    const hasFlow = hasFlowRecorderMethods(recorder);
    const hasEmit = hasEmitRecorderMethods(recorder);

    // Delivery tier (RFC-001): options bag OR the recorder's own
    // `delivery: 'deferred'` field. The field is a string — channel routing
    // above counts event-METHOD properties only, so declaring it never
    // changes which channels the recorder lands on.
    const delivery = options?.delivery ?? recorder.delivery;
    const tierOptions: AttachRecorderOptions | undefined = delivery === undefined ? options : { ...options, delivery };

    // Emit recorders live on the SAME channel as data-flow recorders
    // (ScopeFacade iterates `_recorders` for onEmit dispatch). Short-circuit:
    // if hasData OR hasEmit, the recorder lands on the scope list exactly once.
    if (hasData || hasEmit) this.attachScope(recorder as ScopeRecorder, tierOptions);
    if (hasFlow) this.attachFlow(recorder as FlowRecorder, tierOptions);

    if (!hasData && !hasFlow && !hasEmit && isDevMode()) {
      // Dev-mode only: silent skips are invisible and produce hard-to-debug
      // "why didn't my recorder fire" reports. Per library convention, gated
      // on the central isDevMode() flag (not process.env) so consumers can
      // control dev tooling centrally via enableDevMode()/disableDevMode().
      // eslint-disable-next-line no-console
      console.warn(
        `[footprintjs] attachCombinedRecorder: recorder '${recorder.id}' has ` +
          'no observer event methods — nothing to attach. Did you forget to ' +
          'add an on* handler (onWrite, onDecision, onSubflowEntry, ...)? ' +
          'Note: only OWN properties count; methods on the prototype chain ' +
          'are ignored on purpose.',
      );
    }
  }

  /** Detach every scope recorder with this id — both delivery tiers. */
  detachScope(id: string): void {
    this.scopeRecorders = this.scopeRecorders.filter((r) => r.id !== id);
    this.deferredTier?.removeFromLists(id, { scope: true });
  }

  /** Detach every flow recorder with this id — both delivery tiers. */
  detachFlow(id: string): void {
    this.flowRecorders = this.flowRecorders.filter((r) => r.id !== id);
    this.deferredTier?.removeFromLists(id, { flow: true });
  }

  /** A defensive copy of the scope list (both tiers). */
  scopeList(): ScopeRecorder[] {
    return [...this.scopeRecorders, ...(this.deferredTier?.scopeListRecorders() ?? [])];
  }

  /** A defensive copy of the flow list (both tiers). */
  flowList(): FlowRecorder[] {
    return [...this.flowRecorders, ...(this.deferredTier?.flowListRecorders() ?? [])];
  }

  /**
   * A fresh `run()` clears every attached recorder (`clear()`), so state does
   * not accumulate across runs. The narrative recorder is not cleared: each
   * fresh leg builds a new one ({@link startLeg}).
   */
  clearForRun(): void {
    for (const r of this.flowRecorders) {
      r.clear?.();
    }
    for (const r of this.scopeRecorders) {
      r.clear?.();
    }
    this.deferredTier?.clearRecorders();
  }

  /**
   * Open a leg: a fresh narrative recorder when the narrative is on, none when
   * it is off — or, on a resume (`preserve`), the existing one, so the
   * narrative accumulates across the pause. A fresh executor has no recorder
   * to preserve and starts one for the resumed leg only.
   * Returns the leg's narrative flag.
   */
  startLeg(chartNarrative: boolean, preserve: boolean): boolean {
    const narrativeFlag = this.narrativeEnabled || chartNarrative;
    if (!preserve || !this.combinedRecorder) {
      this.combinedRecorder = narrativeFlag ? new CombinedNarrativeRecorder(this.narrativeOptions) : undefined;
    }
    return narrativeFlag;
  }

  /**
   * The leg's scope factory: the base factory, then every scope modifier in ONE
   * flat pass — the narrative recorder, the user's scope recorders, the
   * deferred tier's scope tap, the redaction policy.
   *
   * The marked-keys set is ALWAYS wired (a stage can call
   * `setValue(key, val, true)` for per-call redaction without any policy).
   */
  composeScopeFactory<TScope>(
    baseFactory: ScopeFactory<TScope>,
    redactionPolicy: RedactionPolicy | undefined,
    sharedRedactedKeys: Set<string>,
  ): ScopeFactory<TScope> {
    const modifiers: ScopeModifier[] = [];

    // 1. Narrative recorder (if enabled)
    if (this.combinedRecorder) {
      const recorder = this.combinedRecorder;
      modifiers.push((target) => {
        target.attachScopeRecorder?.(recorder);
      });
    }

    // 2. User-provided scope recorders
    if (this.scopeRecorders.length > 0) {
      const recorders = this.scopeRecorders;
      modifiers.push((target) => {
        for (const r of recorders) target.attachScopeRecorder?.(r);
      });
    }

    // 2b. Deferred-observer scope tap (RFC-001 Block 7) — a synthetic
    // recorder whose hooks CAPTURE into the bounded queue instead of doing
    // observer work. It rides the same per-stage recorder list as inline
    // recorders, so it receives exactly the post-redaction events they do.
    // Absent (zero work, identical list) when nobody opted into deferral.
    const scopeTap = this.deferredTier?.buildScopeTap();
    if (scopeTap) {
      modifiers.push((target) => {
        target.attachScopeRecorder?.(scopeTap);
      });
    }

    // 3. Redaction policy (conditional — only when policy is set). A
    // `ScopeFacade` already reads the run's rule through its context (the
    // rule is installed on the runtime root); this call supplies it to
    // explicitly registered custom ports, and on a facade it
    // re-states the executor's policy on the shared rule (a no-op).
    if (redactionPolicy) {
      const policy = redactionPolicy;
      modifiers.push((target) => {
        target.useRedactionPolicy?.(policy);
      });
    }

    return ((ctx: any, stageName: string, readOnly?: unknown, envArg?: any) => {
      const scope = baseFactory(ctx, stageName, readOnly, envArg);
      const { target } = requireScopeRuntime(scope);
      // Always wire shared redaction state
      target.useSharedRedactedKeys?.(sharedRedactedKeys);
      // Apply optional modifiers
      for (const mod of modifiers) mod(target);
      return scope;
    }) as ScopeFactory<TScope>;
  }

  /**
   * The leg's flow recorders: the narrative recorder (when on), the user's
   * flow recorders, then the deferred tier's flow tap (RFC-001 Block 7) —
   * appended like any other flow recorder, so the dispatcher needs no tier
   * logic of its own. `undefined` when there are none.
   */
  flowRecordersList(): FlowRecorder[] | undefined {
    const recorders: FlowRecorder[] = [];
    if (this.combinedRecorder) {
      recorders.push(this.combinedRecorder);
    }
    recorders.push(...this.flowRecorders);
    const flowTap = this.deferredTier?.buildFlowTap();
    if (flowTap) recorders.push(flowTap);
    return recorders.length > 0 ? recorders : undefined;
  }

  /** The inline flow listeners of an executor-made event (`onResume`): the narrative recorder first. */
  inlineFlowListeners(): FlowRecorder[] {
    return this.combinedRecorder ? [this.combinedRecorder, ...this.flowRecorders] : this.flowRecorders;
  }

  /**
   * Lazily create the executor's ONE deferred-observer tier (one merged
   * queue, total event order across all three channels). The FIRST deferred
   * attach's options configure the dispatcher; later differing options are
   * dev-warned and ignored (see `AttachRecorderOptions`).
   */
  private ensureDeferredTier(options?: AttachRecorderOptions): DeferredObserverTier {
    if (!this.deferredTier) this.deferredTier = new DeferredObserverTier(options);
    return this.deferredTier;
  }
}
