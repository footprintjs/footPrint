/**
 * ControlDepRecorder — control-dependence tracking from flow events (RFC-003 D5).
 *
 * The gap this fills:
 *   The backtracker's `controlDeps` option (D3) needs a `ControlDepLookup`:
 *   "which decider execution allowed this stage to run?" The engine knows
 *   this during traversal but the commit log doesn't record it — control
 *   flow is a FlowRecorder concern. This recorder is the standard producer:
 *   one subscription, one lookup, plug it straight into `causalChain`.
 *
 * How it works — two correlation structures built during traversal:
 *
 *   1. `parentOf` — the runtime ancestor chain, from every stage event's
 *      `traversalContext.parentRuntimeStageId` (RFC-003 D1). Crosses
 *      subflow boundaries; loop re-entries stay unambiguous because
 *      runtime ids differ per iteration.
 *
 *   2. `branchEntryToDecision` — on `onDecision`/`onSelected` the decision
 *      is recorded as PENDING; the next stage(s) executed whose
 *      `parentRuntimeStageId` IS the decider's runtimeStageId are its
 *      branch entries (1 for a decider, N = selected.length for a
 *      selector). Correlation is by parent-id + count, NOT by stage name —
 *      subflow-mount events carry path-prefixed inner-root names that
 *      don't match `FlowDecisionEvent.chosen`, and selectors emit a
 *      synthetic fork event sharing the selector's own runtimeStageId
 *      (excluded via the self-id guard). A branch that THROWS before
 *      completing consumes its slot via `onError`, so the post-fan-out
 *      convergence stage is never misattributed as a branch entry.
 *
 *   `lookup(runtimeStageId)` then walks the ancestor chain from the stage
 *   upward; the first ancestor (or the stage itself) registered as a
 *   branch entry yields its governing decider — the NEAREST decision.
 *   Nested decisions compose naturally: the backtracker expands the
 *   decider node and asks again.
 *
 * Convention 4: state resets when `traversalContext.runId` changes — each
 * run (and each resume, which mints a fresh runId) starts clean. Control
 * chains therefore do NOT survive a pause/resume boundary: post-resume
 * stages cannot resolve pre-pause decisions.
 *
 * @example
 * ```typescript
 * import { controlDepRecorder, causalChain } from 'footprintjs/trace';
 *
 * const ctrl = controlDepRecorder();
 * executor.attachCombinedRecorder(ctrl); // auto-routes to FlowRecorder channel
 *
 * await executor.run({ input });
 *
 * const dag = causalChain(commitLog, 'approve#2', keysRead, {
 *   controlDeps: ctrl.asLookup(),
 * });
 * ```
 */

import type { DecisionEvidence, SelectionEvidence } from '../decide/types.js';
import type {
  FlowDecisionEvent,
  FlowErrorEvent,
  FlowRecorder,
  FlowSelectedEvent,
  FlowStageEvent,
} from '../engine/narrative/types.js';
import type { ControlDependency, ControlDepLookup } from '../memory/backtrack.js';

/** One recorded decision/selection event (RFC-003 D5). */
export interface ControlDecisionRecord {
  /** runtimeStageId of the decider/selector execution step. */
  deciderRuntimeStageId: string;
  /** Chosen branch display name (decider) or selected names (selector). */
  chosen: string | readonly string[];
  /** Structured evidence from decide()/select(), when the stage used them. */
  evidence?: DecisionEvidence | SelectionEvidence;
  /**
   * The decide() rule label that produced the decision (e.g. 'Good credit').
   * Deciders only — a selector picks N branches and no single label
   * attributes to all of them (inspect `evidence` instead).
   */
  ruleLabel?: string;
}

export interface ControlDepRecorderOptions {
  /** Recorder id. Defaults to `control-deps-N` (auto-incremented). */
  id?: string;
}

/** A decision awaiting branch-entry correlation. */
interface PendingDecision {
  deciderId: string;
  /** How many branch entries are still expected (decider: 1, selector: N). */
  remaining: number;
}

let _counter = 0;

/**
 * Factory — matches the `topologyRecorder()` / `inOutRecorder()` style.
 */
export function controlDepRecorder(options: ControlDepRecorderOptions = {}): ControlDepRecorder {
  return new ControlDepRecorder(options);
}

/**
 * Stateful accumulator that watches FlowRecorder events and answers
 * "which decision allowed this stage to run?" Attach via
 * `executor.attachCombinedRecorder(recorder)` (or `attachFlowRecorder`).
 */
export class ControlDepRecorder implements FlowRecorder {
  readonly id: string;

  /** Runtime ancestor chain: runtimeStageId → parentRuntimeStageId (D1). */
  private readonly parentOf = new Map<string, string>();
  /** Recorded decisions, keyed by decider runtimeStageId. */
  private readonly decisions = new Map<string, ControlDecisionRecord>();
  /** Branch-entry runtimeStageId → governing decider runtimeStageId. */
  private readonly branchEntryToDecision = new Map<string, string>();
  /** Decisions whose branch entries have not all been seen yet. */
  private pending: PendingDecision[] = [];
  /** Stage ids that already consumed a pending slot (entry OR error). */
  private readonly consumedSlots = new Set<string>();
  /** Convention 4 — runId of the run currently being recorded. */
  private lastRunId?: string;

  constructor(options: ControlDepRecorderOptions = {}) {
    this.id = options.id ?? `control-deps-${++_counter}`;
  }

  // ── FlowRecorder hooks ────────────────────────────────────────────────

  onDecision(event: FlowDecisionEvent): void {
    const ctx = event.traversalContext;
    if (!ctx) return;
    this.resetIfNewRun(ctx.runId);

    const deciderId = ctx.runtimeStageId;
    const ruleLabel = matchedRuleLabel(event.evidence);
    this.decisions.set(deciderId, {
      deciderRuntimeStageId: deciderId,
      chosen: event.chosen,
      ...(event.evidence && { evidence: event.evidence }),
      ...(ruleLabel !== undefined && { ruleLabel }),
    });
    this.pending.push({ deciderId, remaining: 1 });
  }

  onSelected(event: FlowSelectedEvent): void {
    const ctx = event.traversalContext;
    if (!ctx) return;
    this.resetIfNewRun(ctx.runId);
    if (event.selected.length === 0) return; // nothing selected → nothing governed

    const deciderId = ctx.runtimeStageId;
    this.decisions.set(deciderId, {
      deciderRuntimeStageId: deciderId,
      chosen: [...event.selected],
      ...(event.evidence && { evidence: event.evidence }),
    });
    this.pending.push({ deciderId, remaining: event.selected.length });
  }

  onStageExecuted(event: FlowStageEvent): void {
    const ctx = event.traversalContext;
    if (!ctx) return;
    this.resetIfNewRun(ctx.runId);

    const { runtimeStageId, parentRuntimeStageId } = ctx;
    if (parentRuntimeStageId) {
      this.parentOf.set(runtimeStageId, parentRuntimeStageId);
      this.consumePendingSlot(runtimeStageId, parentRuntimeStageId, /* register */ true);
    }
  }

  /**
   * A branch that throws never fires `onStageExecuted` — without this hook
   * its pending slot would leak and the post-fan-out convergence stage
   * (whose context also chains to the selector) would be misattributed as
   * a branch entry under best-effort (`failFast: false`) fan-outs.
   */
  onError(event: FlowErrorEvent): void {
    const ctx = event.traversalContext;
    if (!ctx) return;
    this.resetIfNewRun(ctx.runId);
    if (ctx.parentRuntimeStageId) {
      // Record the chain AND attribute the failed stage to its decision —
      // the stage RAN (and may have committed partial writes) because the
      // decision chose it; failing afterwards doesn't undo the dependency.
      this.parentOf.set(ctx.runtimeStageId, ctx.parentRuntimeStageId);
      this.consumePendingSlot(ctx.runtimeStageId, ctx.parentRuntimeStageId, /* register */ true);
    }
  }

  // ── Queries ───────────────────────────────────────────────────────────

  /**
   * Resolve the NEAREST governing decision for an execution step: walks the
   * runtime ancestor chain (the step itself first) until it hits a
   * registered branch entry. `undefined` when the step is not downstream of
   * any recorded decision.
   */
  lookup(runtimeStageId: string): ControlDependency | undefined {
    const seen = new Set<string>();
    let cur: string | undefined = runtimeStageId;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      const deciderId = this.branchEntryToDecision.get(cur);
      if (deciderId !== undefined) {
        const record = this.decisions.get(deciderId);
        return {
          deciderId,
          ...(record?.ruleLabel !== undefined && { label: record.ruleLabel }),
        };
      }
      cur = this.parentOf.get(cur);
    }
    return undefined;
  }

  /** The lookup as a bare function — plug into `causalChain(..., { controlDeps })`. */
  asLookup(): ControlDepLookup {
    return (runtimeStageId) => this.lookup(runtimeStageId);
  }

  /** All decisions recorded for the current run, in event order. */
  getDecisions(): ControlDecisionRecord[] {
    return [...this.decisions.values()];
  }

  /** Reset all state (also happens automatically on runId change). */
  clear(): void {
    this.parentOf.clear();
    this.decisions.clear();
    this.branchEntryToDecision.clear();
    this.pending = [];
    this.consumedSlots.clear();
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /** Convention 4: a new runId means a new run — reset transient state. */
  private resetIfNewRun(runId: string): void {
    if (runId === this.lastRunId) return;
    this.clear();
    this.lastRunId = runId;
  }

  /**
   * If `parentRuntimeStageId` is a decider with an unmatched pending slot,
   * consume one. `register` controls whether the stage is recorded as a
   * branch entry (stage executed/errored) — both paths consume the slot so
   * counts stay exact even when a stage produces both events.
   */
  private consumePendingSlot(runtimeStageId: string, parentRuntimeStageId: string, register: boolean): void {
    if (runtimeStageId === parentRuntimeStageId) return; // synthetic self-events
    if (this.consumedSlots.has(runtimeStageId)) return;

    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i];
      if (p.deciderId !== parentRuntimeStageId) continue;

      this.consumedSlots.add(runtimeStageId);
      if (register) this.branchEntryToDecision.set(runtimeStageId, p.deciderId);
      p.remaining--;
      if (p.remaining <= 0) this.pending.splice(i, 1);
      return;
    }
  }
}

/**
 * The decide() rule label that produced the decision: the matched rule
 * mapping to the chosen branch (first matched rule as fallback).
 */
function matchedRuleLabel(evidence: DecisionEvidence | undefined): string | undefined {
  if (!evidence) return undefined;
  const rule =
    evidence.rules.find((r) => r.matched && r.branch === evidence.chosen) ?? evidence.rules.find((r) => r.matched);
  return rule?.label;
}
