import type { AttemptRecord, AttemptSummary, LateWrite } from '../attempt/types.js';
import { type SourceReadCounter, EMPTY_SOURCE_READ_COUNTS } from '../capture/sourceReadCounts.js';
import type { StageAttention } from './attention.js';
import type { DiagnosticCollector } from './DiagnosticCollector.js';
import type { StageSnapshot } from './frameTypes.js';
import type { RedactionRule } from './redaction.js';
import { SCOPE_PLACEHOLDER } from './redactionValues.js';
import { activeRule } from './retainedValue/index.js';

type SnapshotFrame = {
  readonly stageId: string;
  readonly runtimeStageId: string;
  readonly stageName: string;
  readonly isDecider: boolean;
  readonly isFork: boolean;
  readonly description?: string;
  readonly subflowId?: string;
  readonly debug: Pick<
    DiagnosticCollector,
    'logContext' | 'errorContext' | 'metricContext' | 'evalContext' | 'flowMessages'
  >;
  readonly readSources?: { readonly observing: boolean };
  readonly captureClosureTracking?: boolean;
};

type SnapshotLinks<Frame> = {
  readonly next?: Frame;
  readonly children?: readonly Frame[];
};

/** Read retained frame data at the point it is used, including through pending-write projection. */
export type StageSnapshotInputs<Frame> = {
  sourceReadCounter(frame: Frame): Pick<SourceReadCounter, 'snapshot'> | undefined;
  sourceInvocations(frame: Frame): number;
  closureInvocations(frame: Frame): { readonly count: number } | undefined;
  retainedWrites(frame: Frame): Readonly<Record<string, { readonly value: unknown }>>;
  stageReads(frame: Frame): Readonly<Record<string, unknown>>;
  unsetNestedReads(
    frame: Frame,
  ): ReadonlyMap<string, { readonly path: readonly string[]; readonly key: string }> | undefined;
  attempts(frame: Frame): readonly AttemptRecord[] | undefined;
  attemptSummary(frame: Frame): AttemptSummary | undefined;
  lateWrites(frame: Frame): readonly LateWrite[] | undefined;
  attemptsDropped(frame: Frame): number;
  attention(frame: Frame): Pick<StageAttention, 'snapshot'> | undefined;
};

export function buildStageSnapshotTree<Frame extends SnapshotLinks<Frame>>(
  rootFrame: Frame,
  redaction: RedactionRule | undefined,
  project: (frame: Frame, rule: RedactionRule | undefined) => StageSnapshot,
): StageSnapshot {
  // Use an explicit stack because next chains can reach tens of thousands of stages.
  const rule = activeRule(redaction);
  const root = project(rootFrame, rule);
  const work: Array<{ ctx: Frame; snap: StageSnapshot }> = [{ ctx: rootFrame, snap: root }];
  while (work.length > 0) {
    const { ctx, snap } = work.pop()!;
    if (ctx.next) {
      const nextSnap = project(ctx.next, rule);
      snap.next = nextSnap;
      work.push({ ctx: ctx.next, snap: nextSnap });
    }
    if (ctx.children) {
      snap.children = ctx.children.map((child) => {
        const childSnap = project(child, rule);
        work.push({ ctx: child, snap: childSnap });
        return childSnap;
      });
    }
  }
  return root;
}

/** This frame's fields, before the execution walk links its successors. */
export function buildStageSnapshot<Frame extends SnapshotFrame>(
  frame: Frame,
  inputs: StageSnapshotInputs<Frame>,
  rule: RedactionRule | undefined,
): StageSnapshot {
  const snapshot: StageSnapshot = {
    id: frame.stageId,
    runtimeStageId: frame.runtimeStageId || undefined,
    name: frame.stageName,
    isDecider: frame.isDecider,
    isFork: frame.isFork,
    logs: frame.debug.logContext,
    errors: frame.debug.errorContext,
    metrics: frame.debug.metricContext,
    evals: frame.debug.evalContext,
  };
  if (frame.readSources?.observing) {
    snapshot.readSourceCounts = inputs.sourceReadCounter(frame)?.snapshot() ?? EMPTY_SOURCE_READ_COUNTS;
    snapshot.readSourceInvocations = inputs.sourceInvocations(frame);
  }
  if (frame.captureClosureTracking) snapshot.nativeInvocations = inputs.closureInvocations(frame)?.count ?? 0;
  const stageWrites = inputs.retainedWrites(frame);
  if (Object.keys(stageWrites).length > 0) {
    // Extract values only for the snapshot (strip operation metadata)
    const writes: Record<string, unknown> = {};
    for (const [k, entry] of Object.entries(stageWrites)) {
      writes[k] = entry.value;
    }
    snapshot.stageWrites = writes;
  }
  const stageReads = inputs.stageReads(frame);
  const reads = Object.keys(stageReads);
  if (reads.length > 0) {
    // Apply later whole-key marks to the snapshot's copy.
    snapshot.stageReads = { ...stageReads };
    let undefinedKeys: string[] | undefined;
    for (const key of reads) {
      if (snapshot.stageReads[key] !== undefined) continue;
      const address = rule && inputs.unsetNestedReads(frame)?.get(key);
      if (rule?.verdictAt(address?.path ?? [], address?.key ?? key).kind === 'whole')
        snapshot.stageReads[key] = SCOPE_PLACEHOLDER;
      else (undefinedKeys ??= []).push(key);
    }
    if (undefinedKeys) snapshot.undefinedReadKeys = Object.freeze(undefinedKeys);
  }
  if (frame.description) {
    snapshot.description = frame.description;
  }
  if (frame.subflowId) {
    snapshot.subflowId = frame.subflowId;
  }
  if (frame.debug.flowMessages.length > 0) {
    snapshot.flowMessages = frame.debug.flowMessages;
  }
  // A copy of the list (the records themselves are frozen): a reader of one snapshot never sees a later
  // attempt arrive in it, and never edits the frame's own list.
  const attempts = inputs.attempts(frame);
  if (attempts) snapshot.attempts = Object.freeze([...attempts]);
  const attemptSummary = inputs.attemptSummary(frame);
  if (attemptSummary) snapshot.attemptSummary = attemptSummary;
  const lateWrites = inputs.lateWrites(frame);
  if (lateWrites) snapshot.lateWrites = Object.freeze([...lateWrites]);
  const attemptsDropped = inputs.attemptsDropped(frame);
  if (attemptsDropped > 0) snapshot.attemptsDropped = attemptsDropped;
  const attention = inputs.attention(frame)?.snapshot();
  if (attention?.length) snapshot.attention = attention;
  return snapshot;
}
