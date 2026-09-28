/**
 * A resume re-enters ONCE, then the run belongs to the real chart (9.28.0).
 *
 * THE BUG (9.27.0 and earlier): `resume()` built a synthetic structure to get
 * back to the paused stage — a stand-in node carrying the paused stage's id
 * (its function = the resume half), a leaf subflow whose root was swapped for
 * that stand-in, the resumed traversal rooted at the stand-in (or at the outer
 * mount), and the checkpoint's per-subflow seeds. All of it stayed in force for
 * the WHOLE resumed run:
 *
 *   - the traverser's node map was built from the stand-in, so a loop back to
 *     the paused id found the stand-in and re-ran the RESUME HALF — the stage
 *     never paused again, a re-ask was impossible (fact 1);
 *   - a loop target upstream of the resume point was not in that map at all,
 *     so the bare loop stub won the slot: one stage ran and the run ended
 *     SILENTLY (fact 2);
 *   - a later entry into the paused subflow would have found the swapped root
 *     and the stale seed (inputMapper skipped);
 *   - a pause two subflows deep re-ran the outer subflow's stages before the
 *     inner mount.
 *
 * THE LAW (`engine/handlers/ResumeEntry.ts`): the resume's synthetic entry is
 * ONE-SHOT. It is where the resumed traversal STARTS — never a node any id can
 * resolve to — and each subflow on the pause path takes its seed and its entry
 * point exactly once, on its first entry. Everything after that resolves
 * against the real chart.
 *
 * Every scenario runs twice: resumed on the executor that paused, and on a
 * fresh executor from a JSON round-tripped checkpoint.
 *
 * Test type: scenario. (Unit: test/lib/engine/unit/ResumeEntry.test.ts ·
 * property: resume-real-chart.property.test.ts · invariants, boundary,
 * security, performance, load: the sibling resume-real-chart.*.test.ts files ·
 * dispatcher continuations at every level: resume-dispatchers.test.ts ·
 * parallel siblings pausing together: resume-sibling-pauses.test.ts · what is
 * still not rebuilt: resume-known-limitations.test.ts · back-compat:
 * resume-real-chart-9.27.0-checkpoints.test.ts · integration:
 * examples/runtime-features/pause-resume/09-ask-again-in-a-loop.ts and
 * 10-two-questions-at-once.ts.)
 */

import { describe, expect, it } from 'vitest';

import {
  type ResumeMode,
  askLoopInSubflowChart,
  askLoopTopLevelChart,
  drive,
  HEALTHY,
  interruptInLoopingBranchChart,
  loopInsideSubflowChart,
  loopPastMountChart,
  loopPastTopLevelPauseChart,
  pauseEveryPassChart,
  pauseInLoopBodySubflowChart,
  twoDeepChart,
} from './resume-real-chart-fixture.js';

const MODES: ResumeMode[] = ['same', 'cross'];

describe.each(MODES)('resume resolves against the real chart — %s-executor', (mode) => {
  it('fact 1: a decider looping back to the PAUSED stage inside a subflow pauses it again (a re-ask)', async () => {
    const run = await drive(askLoopInSubflowChart(), mode);

    expect(run.trace).toEqual(HEALTHY.askLoopInSubflow.trace);
    expect(run.pauses).toBe(2);
    // The second pause is the REAL stage's execute half, at the real place.
    const second = run.checkpoints[1];
    expect(second.pausedStageId).toBe('sf/ask');
    expect(second.subflowPath).toEqual(['sf']);
    expect(second.pauseData).toEqual({ question: 'q' });
  });

  it('fact 1 without a subflow: the loop to the paused id reaches the real node, not the stand-in', async () => {
    const run = await drive(askLoopTopLevelChart(), mode);

    expect(run.trace).toEqual(HEALTHY.askLoopTopLevel.trace);
    expect(run.pauses).toBe(2);
    expect(run.checkpoints[1].pausedStageId).toBe('ask');
    expect(run.checkpoints[1].subflowPath).toEqual([]);
  });

  it('fact 2: a pause in a subflow of the loop body resumes, reaches the loop head, and finishes', async () => {
    const run = await drive(pauseInLoopBodySubflowChart(), mode);

    expect(run.trace).toEqual(HEALTHY.pauseInLoopBodySubflow.trace);
    expect(run.pauses).toBe(1);
  });

  it('fact 3 (stays true): interrupt() in the looping branch re-runs the branch and the loop continues', async () => {
    const run = await drive(interruptInLoopingBranchChart(), mode);

    expect(run.trace).toEqual(HEALTHY.interruptInLoopingBranch.trace);
    expect(run.pauses).toBe(2);
    // The branch's own function ran again — its resume half never did.
    expect(run.trace).not.toContain('RESUME-HALF');
    for (const checkpoint of run.checkpoints) expect(checkpoint.pausedBy).toBe('interrupt');
  });

  it('a top-level pause whose loop head is UPSTREAM of it: the loop reaches the head and the run finishes', async () => {
    const run = await drive(loopPastTopLevelPauseChart(), mode);

    expect(run.trace).toEqual(HEALTHY.loopPastTopLevelPause.trace);
  });

  it('a pause inside a loop body INSIDE a subflow: the subflow’s own loop reaches its head', async () => {
    const run = await drive(loopInsideSubflowChart(), mode);

    expect(run.trace).toEqual(HEALTHY.loopInsideSubflow.trace);
  });

  it('a loop past the paused subflow’s mount: the next entry is FRESH — inputMapper runs, real root, no stale seed', async () => {
    const run = await drive(loopPastMountChart(), mode);

    expect(run.trace).toEqual(HEALTHY.loopPastMount.trace);
    // `start2`/`start3`: the subflow began at its real first stage with the
    // inputMapper's `pass`. No second `answer…`: the resume half ran once.
    expect(run.trace.filter((t) => t.startsWith('answer'))).toEqual(['answer1']);
  });

  it('two (three) pauses in one run from the same mount: every resume enters the right pass', async () => {
    const run = await drive(pauseEveryPassChart(), mode);

    expect(run.trace).toEqual(HEALTHY.pauseEveryPass.trace);
    expect(run.pauses).toBe(3);
    expect(run.checkpoints.map((c) => c.subflowPath)).toEqual([['sf-inputs'], ['sf-inputs'], ['sf-inputs']]);
  });

  it('a pause two subflows deep continues INSIDE the inner subflow — the outer pre-mount stage never re-runs', async () => {
    const run = await drive(twoDeepChart(), mode);

    expect(run.checkpoints[0].subflowPath).toEqual(['sf-a', 'sf-a/sf-b']);
    expect(run.trace).toEqual(HEALTHY.twoDeep.trace);
    expect(run.state.aPreRuns).toBe(1);
  });
});
