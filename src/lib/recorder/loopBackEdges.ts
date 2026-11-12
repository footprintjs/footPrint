/**
 * LoopBackEdges — which links of the runtime ancestor chain are a loop's back-edge, and which steps leave by them.
 *
 * THE RULE. A step is after a loop exactly when its walk up the chain passes a run of the loop's GATE (the step
 * that chose the looping branch: the hop source's parent) before it reaches the loop's re-entry; such a step goes
 * on from the loop's entry, every other step crosses the back-edge to the decision that sent the run round again.
 * Example — `work → more ─ again (loopTo work) | leave`, then more's own next `after1`, one pass back:
 * `after1#7 → more#5 → work#4` passes `more`, so it goes on from work#1 (under no decision, as with zero passes);
 * `more#5` itself starts the walk, passes nothing, and crosses `work#4 ⟵ again#3` to more#2 ("Left to do").
 *
 * Why: `ControlDepRecorder · lookup` answers "which decision allowed this step to run?" by walking
 * `parentRuntimeStageId` links to the nearest chosen branch, and a `loopTo` hop is one of those links (the
 * re-entered target's parent is the branch that looped). A step after the loop runs whenever the loop is left, on
 * any pass, like a selector's join, so a decision that chose to go round again does not govern it. The gate
 * decides membership from the walk itself, not from stage names seen in earlier passes, so a step that first runs
 * in the last pass (a dynamic next, a fan-out with more branches) is answered as exactly as any other.
 *
 * COST. Per execution, two map writes as it is seen; per re-entry, one more (its gate and entry). `entry` points at
 * the loop's first run in this activation, so a walk leaves a loop in one jump at any pass count; `lookup` keeps
 * the stage ids it passed in one set. Pinned, counted, in test/lib/recorder/ControlDepRecorder.loop-body.test.ts.
 */

import { stageIdOf } from 'foottrace';

/** A re-entered target execution. */
interface ReEntry {
  /** Stage id of the step that chose the looping branch: a walk that passed it is outside the loop. */
  readonly gate: string | undefined;
  /** `<hop source stage id>><target stage id>` — consecutive passes of one loop share it. */
  readonly loop: string;
  /** The loop's first run of its target in this activation: where a step outside the loop walks on. */
  readonly entry: string;
}

export class LoopBackEdges {
  /** Hop sources whose re-entry has not been seen yet. */
  private readonly pendingSources = new Set<string>();
  /** Stage id → its latest execution seen: the target's previous run when a re-entry arrives. */
  private readonly lastRunOf = new Map<string, string>();
  private readonly reentries = new Map<string, ReEntry>();

  /** `onLoop`: the execution `source` hopped back to an earlier stage. */
  noteLoop(source: string): void {
    this.pendingSources.add(source);
  }

  /** Every step seen (a parentless root too: a loop may go back to it); the first child of a pending hop source is its re-entry. */
  noteStage(runtimeStageId: string, parentRuntimeStageId: string | undefined, parentOf: ReadonlyMap<string, string>) {
    if (runtimeStageId === parentRuntimeStageId) return;
    const stageId = stageIdOf(runtimeStageId);
    const previous = this.lastRunOf.get(stageId);
    this.lastRunOf.set(stageId, runtimeStageId);
    if (parentRuntimeStageId === undefined || !this.pendingSources.delete(parentRuntimeStageId)) return;
    if (previous === undefined || previous === runtimeStageId) return;
    const gateRun = parentOf.get(parentRuntimeStageId);
    const loop = `${stageIdOf(parentRuntimeStageId)}>${stageId}`;
    const before = this.reentries.get(previous);
    this.reentries.set(runtimeStageId, {
      gate: gateRun === undefined ? undefined : stageIdOf(gateRun),
      loop,
      entry: before?.loop === loop ? before.entry : previous,
    });
  }

  /**
   * When `reentry` is a loop's re-entered target and the walk has `passed` a run of that loop's gate, the execution
   * to go on from (the loop's entry); otherwise `undefined` — cross the back-edge.
   */
  exitTo(reentry: string, passed: ReadonlySet<string>): string | undefined {
    const found = this.reentries.get(reentry);
    if (found === undefined || found.gate === undefined || !passed.has(found.gate)) return undefined;
    return found.entry;
  }

  clear(): void {
    this.pendingSources.clear();
    this.lastRunOf.clear();
    this.reentries.clear();
  }
}
