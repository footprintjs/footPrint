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
 *   `after1` never ran in a pass of that loop, so the walk jumps from work#4 to the loop's entry (work#1)
 *   and goes on from there: under no decision — as with zero passes.
 *
 * THE BODY of a loop is every stage id that ran IN one of its passes: an execution between the target's
 * previous run P and the hop source S (by execution index) whose parent chain reaches P. "Hangs under P"
 * is what takes in parallel children (a fork child's parent is the fork, not an ancestor of the join), a
 * fan-out's `~` branches and a mount's inner steps, and what keeps out a parallel sibling of the whole
 * loop that ran at the same time elsewhere. A step inside a sub-flowchart counts when its mount ran in a
 * pass (its stage id's path prefix).
 *
 * COST — chosen: collected once, eagerly, when the re-entry is seen (every execution of the pass has
 * reported by then: the hop fires after its source). One pass costs one visit per execution index in
 * (P, S] plus at most one parent step per execution in that range (each answer is memoised for the
 * pass), so a whole run pays in proportion to the executions its loops ran — never a walk of the whole
 * run per pass. `lookup` then pays one set check and one jump per loop it leaves (`entry` points straight
 * at the loop's first run, not at the previous pass), so a step after a 1,000-pass loop walks as far as
 * after a one-pass loop. Pinned, counted, in test/lib/recorder/ControlDepRecorder.loop-exit.test.ts.
 *
 * KNOWN LIMIT: the body holds what ran in the passes BEFORE the one being asked about. A step inside the
 * body that is reached only through a plain next (no decision of its own on the way) and runs for the
 * FIRST time in the last pass is taken for a step after the loop, and is answered by what governed the
 * loop's entry instead of the previous pass's decision. A branch taken for the first time is not
 * affected: its own decision answers before the back-edge is reached. Pinned as a known limit.
 */

import { parseRuntimeStageId, stageIdOf } from 'foottrace';

/** A re-entered target: which loop it belongs to and where that loop was first entered. */
interface ReEntry {
  /** `<hop source stage id>><target stage id>` — the passes of one loop share it. */
  readonly loop: string;
  /** The loop's first run of its target in this activation — where a step outside the loop walks on. */
  readonly entry: string;
}

const indexOf = (runtimeStageId: string): number => parseRuntimeStageId(runtimeStageId).executionIndex;

export class LoopBackEdges {
  /** Hop sources whose re-entry has not been seen yet. */
  private readonly pendingSources = new Set<string>();
  /** Every execution seen, by execution index — how a pass's range is read. */
  private readonly byIndex = new Map<number, string>();
  /** Stage id → its latest execution seen: the target's previous run when a re-entry arrives. */
  private readonly lastRunOf = new Map<string, string>();
  private readonly reentries = new Map<string, ReEntry>();
  /** Loop → every stage id that ran in one of its passes so far. */
  private readonly bodies = new Map<string, Set<string>>();

  /** `onLoop`: the execution `source` hopped back to an earlier stage. */
  noteLoop(source: string): void {
    this.pendingSources.add(source);
  }

  /**
   * Every step seen (a parentless root too: a loop may go back to it). The first one whose parent is a
   * pending hop source is the re-entry; its pass is collected now, while the chain is complete.
   */
  noteStage(runtimeStageId: string, parentRuntimeStageId: string | undefined, parentOf: ReadonlyMap<string, string>) {
    if (runtimeStageId === parentRuntimeStageId) return;
    this.byIndex.set(indexOf(runtimeStageId), runtimeStageId);
    const stageId = stageIdOf(runtimeStageId);
    const previous = this.lastRunOf.get(stageId);
    this.lastRunOf.set(stageId, runtimeStageId);
    if (parentRuntimeStageId === undefined || !this.pendingSources.delete(parentRuntimeStageId)) return;
    if (previous === undefined || previous === runtimeStageId) return;
    const loop = `${stageIdOf(parentRuntimeStageId)}>${stageId}`;
    this.collectPass(loop, previous, parentRuntimeStageId, parentOf);
    const before = this.reentries.get(previous);
    this.reentries.set(runtimeStageId, { loop, entry: before?.loop === loop ? before.entry : previous });
  }

  /**
   * When `reentry` is a loop's re-entered target and the step `queryId` never ran in a pass of that loop,
   * the execution to continue the walk from (the loop's entry); otherwise `undefined` — keep walking
   * across the back-edge.
   */
  exitTo(reentry: string, queryId: string): string | undefined {
    const found = this.reentries.get(reentry);
    if (found === undefined) return undefined;
    const body = this.bodies.get(found.loop);
    const query = stageIdOf(queryId);
    for (let end = query.length; end > 0; end = query.lastIndexOf('/', end - 1)) {
      if (body?.has(query.slice(0, end))) return undefined;
    }
    return found.entry;
  }

  clear(): void {
    this.pendingSources.clear();
    this.byIndex.clear();
    this.lastRunOf.clear();
    this.reentries.clear();
    this.bodies.clear();
  }

  /** Adds to the loop's body every execution in (previous, source] that hangs under `previous`. */
  private collectPass(loop: string, previous: string, source: string, parentOf: ReadonlyMap<string, string>): void {
    let body = this.bodies.get(loop);
    if (body === undefined) this.bodies.set(loop, (body = new Set()));
    body.add(stageIdOf(previous));
    const from = indexOf(previous);
    const under = new Map<string, boolean>([[previous, true]]);
    for (let index = from + 1, to = indexOf(source); index <= to; index++) {
      const id = this.byIndex.get(index);
      if (id !== undefined && hangsUnder(id, from, under, parentOf)) body.add(stageIdOf(id));
    }
  }
}

/** Whether `id`'s parent chain reaches the pass's start; every link it walks is answered in `under` too. */
function hangsUnder(id: string, from: number, under: Map<string, boolean>, parentOf: ReadonlyMap<string, string>) {
  const path: string[] = [];
  let answer = false;
  for (let cur: string | undefined = id; cur !== undefined; cur = parentOf.get(cur)) {
    const known = under.get(cur);
    if (known !== undefined) {
      answer = known;
      break;
    }
    // A parent always ran before its child, so an execution at or before the start cannot lead back to it.
    if (indexOf(cur) <= from) break;
    path.push(cur);
  }
  for (const step of path) under.set(step, answer);
  return answer;
}
