/**
 * LoopBackEdges — which links of the runtime ancestor chain are a loop's back-edge, and who they govern.
 *
 * Why it exists: `ControlDepRecorder · lookup` answers "which decision allowed this step to run?" by
 * walking `parentRuntimeStageId` links up to the nearest chosen branch. A `loopTo` hop is one of those
 * links: the re-entered target's parent is the branch that looped. For a step INSIDE the loop body that
 * link is the right answer — pass k ran because the decision of pass k-1 chose to go round again. For a
 * step AFTER the loop it is not: the step runs whenever the loop is left, on any pass, so it is governed
 * by what governed the loop when it was ENTERED (the same law as a selector's join, which no branch
 * governs). Walking the back-edge anyway made it inherit a decision that chose to CONTINUE, and the
 * answer changed with the pass count (zero passes: none; one: the first decision; three: the third).
 *
 * Example — `work → more ─ again (loopTo work) | leave`, then more's own next `after1`, one pass back:
 *   after1#7 → more#5 → work#4 ⟵back-edge⟵ again#3 (branch of more#2, "Left to do")
 *   `after1` is not in that loop's body {work, more, again}, so the walk jumps from work#4 to the
 *   previous pass's `work` (work#1) and goes on from there: under no decision — as with zero passes.
 *
 * Collected during traversal from two flow events (`onLoop` names the hop's source; the next step whose
 * parent is that source is the re-entry); a pass's body is read once, lazily, from the chain itself.
 */

import { stageIdOf } from 'foottrace';

/** One pass of a loop, read back from the chain: the stage ids it ran and the previous run of its target. */
interface LoopPass {
  readonly body: ReadonlySet<string>;
  /** The target's execution one pass earlier — where a step outside the loop goes on walking. */
  readonly previous: string;
}

export class LoopBackEdges {
  /** Hop sources whose re-entry has not been seen yet. */
  private readonly pendingSources = new Set<string>();
  /** Re-entered target execution → the hop source (its parent across the back-edge). */
  private readonly sourceOf = new Map<string, string>();
  private readonly passes = new Map<string, LoopPass | null>();

  /** `onLoop`: the execution `source` hopped back to an earlier stage. */
  noteLoop(source: string): void {
    this.pendingSources.add(source);
  }

  /** Every step seen with a parent: the first one whose parent is a pending hop source is the re-entry. */
  noteStage(runtimeStageId: string, parentRuntimeStageId: string): void {
    if (runtimeStageId === parentRuntimeStageId) return;
    if (this.pendingSources.delete(parentRuntimeStageId)) this.sourceOf.set(runtimeStageId, parentRuntimeStageId);
  }

  /**
   * When `reentry` is a loop's re-entered target and the step `queryId` lies OUTSIDE that loop's body,
   * the execution to continue the walk from (the target one pass earlier); otherwise `undefined` —
   * keep walking across the back-edge. A step inside a sub-flowchart counts as inside the body when its
   * mount is (its stage id's path prefix).
   */
  exitTo(reentry: string, queryId: string, parentOf: ReadonlyMap<string, string>): string | undefined {
    const source = this.sourceOf.get(reentry);
    if (source === undefined) return undefined;
    const pass = this.passOf(reentry, source, parentOf);
    if (!pass) return undefined;
    const query = stageIdOf(queryId);
    for (let end = query.length; end > 0; end = query.lastIndexOf('/', end - 1)) {
      if (pass.body.has(query.slice(0, end))) return undefined;
    }
    return pass.previous;
  }

  clear(): void {
    this.pendingSources.clear();
    this.sourceOf.clear();
    this.passes.clear();
  }

  /** Walks from the hop source up to the target's previous execution; `null` when the chain does not reach it. */
  private passOf(reentry: string, source: string, parentOf: ReadonlyMap<string, string>): LoopPass | null {
    const cached = this.passes.get(reentry);
    if (cached !== undefined) return cached;
    const target = stageIdOf(reentry);
    const body = new Set<string>();
    const seen = new Set<string>();
    let pass: LoopPass | null = null;
    for (let cur: string | undefined = source; cur !== undefined && !seen.has(cur); cur = parentOf.get(cur)) {
      seen.add(cur);
      const stageId = stageIdOf(cur);
      body.add(stageId);
      if (stageId === target) {
        pass = { body, previous: cur };
        break;
      }
    }
    this.passes.set(reentry, pass);
    return pass;
  }
}
