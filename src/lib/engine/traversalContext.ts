/**
 * traversalContext — the ONE constructor of `TraversalContext` (F7, 9.37.0).
 *
 * `TraversalContext` is the correlation stamp every FlowRecorder event carries
 * ("the entire event-correlation model rests on" scope and flow events sharing
 * it). Until 9.36.0 three sites built it by hand — the traverser per stage, the
 * traverser's synthetic run-boundary root, and the executor's `onResume` — and
 * the third forecast what it could not know (depth 0, no subflow). Now all
 * three call `traversalContextFor`, through the two named shapes below.
 *
 * Key ORDER and key PRESENCE are part of the bytes (a recorder that serializes
 * the stamp sees them), so `traversalContextFor` writes a key only when the
 * caller passed it — `parentStageId`, `subflowId` and `subflowPath` are written
 * even when `undefined` if the caller names them, which is what a stage stamp
 * has always done.
 */

import { type RuntimeStageId, buildRuntimeStageId } from '../ids/runtimeStageId.js';
import type { ResumeLink, TraversalContext } from './narrative/types.js';

/** Everything a stamp can carry; optional keys are written only when PRESENT on this object. */
export interface TraversalStamp {
  readonly runId: string;
  readonly stageId: string;
  readonly runtimeStageId: string;
  readonly stageName: string;
  readonly parentStageId?: string;
  readonly parentRuntimeStageId?: string;
  readonly loopIteration?: number;
  readonly subflowId?: string;
  readonly subflowPath?: string;
  readonly depth: number;
  readonly resumedFrom?: ResumeLink;
}

/**
 * Build the stamp. `parentStageId` / `subflowId` / `subflowPath` are copied
 * when the key is present (even as `undefined`); `parentRuntimeStageId`,
 * `loopIteration` and `resumedFrom` only when they hold a value.
 */
export function traversalContextFor(stamp: TraversalStamp): TraversalContext {
  return {
    runId: stamp.runId,
    stageId: stamp.stageId,
    runtimeStageId: stamp.runtimeStageId,
    stageName: stamp.stageName,
    ...(has(stamp, 'parentStageId') && { parentStageId: stamp.parentStageId }),
    ...(stamp.parentRuntimeStageId && { parentRuntimeStageId: stamp.parentRuntimeStageId }),
    ...(stamp.loopIteration !== undefined && { loopIteration: stamp.loopIteration }),
    ...(has(stamp, 'subflowId') && { subflowId: stamp.subflowId }),
    ...(has(stamp, 'subflowPath') && { subflowPath: stamp.subflowPath }),
    depth: stamp.depth,
    ...(stamp.resumedFrom && { resumedFrom: stamp.resumedFrom }),
  };
}

/** Own-key presence — `undefined` counts as present (a stage stamp always names these keys). */
function has(stamp: TraversalStamp, key: 'parentStageId' | 'subflowId' | 'subflowPath'): boolean {
  return Object.prototype.hasOwnProperty.call(stamp, key);
}

/** The synthetic stage id of the run-boundary stamp (`onRunStart` / `onRunEnd` / `onRunFailed`). */
const ROOT_STAGE_ID = '__root__';

/**
 * The run-boundary stamp: root-stage defaults (`'__root__'`, `'__root__#0'`,
 * depth 0) so the `runId` is reliably available on run events without forcing
 * recorders to handle `traversalContext === undefined`.
 */
export function rootTraversalContext(runId: string): TraversalContext {
  return traversalContextFor({
    runId,
    stageId: ROOT_STAGE_ID,
    runtimeStageId: buildRuntimeStageId(ROOT_STAGE_ID, 0),
    stageName: ROOT_STAGE_ID,
    depth: 0,
  });
}

/**
 * The `onResume` stamp. Names the stand-in's own execution (`runtimeStageId`,
 * the id its commit carries), the REAL subflow it runs in — `subflowId` is the
 * paused stage's innermost subflow (`checkpoint.subflowPath`'s last entry, the
 * prefixed id every in-subflow stamp carries), absent at the top level — and
 * `depth` = how many subflows deep that is. `resumedFrom` LINKS to the paused
 * execution (OTel span-link style) instead of forecasting a parent.
 */
export function resumeTraversalContext(resume: {
  readonly runId: string;
  readonly stageId: string;
  readonly stageName: string;
  readonly runtimeStageId: RuntimeStageId;
  /** `checkpoint.subflowPath`: the prefixed id of every subflow on the way down, outermost first. */
  readonly subflowPath: readonly string[];
  readonly resumedFrom?: ResumeLink;
}): TraversalContext {
  const innermost = resume.subflowPath[resume.subflowPath.length - 1];
  return traversalContextFor({
    runId: resume.runId,
    stageId: resume.stageId,
    runtimeStageId: resume.runtimeStageId,
    stageName: resume.stageName,
    ...(innermost !== undefined && { subflowId: innermost }),
    depth: resume.subflowPath.length,
    ...(resume.resumedFrom && { resumedFrom: resume.resumedFrom }),
  });
}
