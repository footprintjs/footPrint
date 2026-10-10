/**
 * Code written against `StageSnapshot` before C6 — compiled, never run, by
 * execution-tree-supertype.test.ts, which requires ZERO diagnostics against this tree AND against a
 * release from before the change (the imports re-pointed at `footprintjs-baseline`, pinned exactly), so
 * this file is a faithful copy of what compiled before the readers took `ExecutionTree`.
 *
 * The shapes are the published consumers' — agentfootprint's `milestoneStops` (a function whose tree
 * parameter is annotated `StageSnapshot`, assigned as a strategy), the Lens's `tagAxis` (a stored tree
 * cast to the strategy's own parameter type), the 9.18.0 arrow — plus a class and a method that read a
 * field only a `StageSnapshot` has.
 */
import type { CommitBundle } from 'foottrace';
import type { Stop, TimeTravelStrategy } from 'foottrace';
import { commitStops, filterStops, keysReadFromExecutionTree, tagStops, timeTravel } from 'foottrace';

import type { StageSnapshot } from '../../src/advanced.js';

declare const snapshot: { commitLog: CommitBundle[]; executionTree: StageSnapshot };

// ── Callers: a snapshot's tree handed to every reader ──────────────────────

export const stops: Stop[] = commitStops(snapshot.commitLog, snapshot.executionTree);
export const tagged = tagStops(['milestone']).stopsFor(snapshot.commitLog, snapshot.executionTree);
export const reads = keysReadFromExecutionTree(snapshot.executionTree);
export const readsOfMany = keysReadFromExecutionTree([snapshot.executionTree, snapshot.executionTree]);
export const cursor = timeTravel({ commitLog: snapshot.commitLog, executionTree: snapshot.executionTree });

// ── Implementers ───────────────────────────────────────────────────────────

interface Milestone {
  kind: 'turn' | 'tool';
}

/** agentfootprint's shape: the tree parameter annotated `StageSnapshot`, handed on to `commitStops`. */
export function milestoneStops(commitLog: readonly CommitBundle[], executionTree?: StageSnapshot): Stop<Milestone>[] {
  return filterStops<Milestone>(commitStops(commitLog, executionTree), () => ({ meta: { kind: 'turn' } }));
}

/** … assigned as a strategy, and that strategy to a bare one. */
export const milestoneStopsStrategy: TimeTravelStrategy<Milestone> = { stopsFor: milestoneStops };
export const bareStrategy: TimeTravelStrategy = milestoneStopsStrategy;

/** A class that reads a field only a `StageSnapshot` has. */
export class NamedRootStops implements TimeTravelStrategy {
  stopsFor(commitLog: readonly CommitBundle[], executionTree?: StageSnapshot): Stop[] {
    const rootName = executionTree?.name;
    return commitStops(commitLog, executionTree).map((stop) => ({ ...stop, label: rootName ?? stop.label }));
  }
}

/** An object literal's method, annotated the same way. */
export const loggedOnly: TimeTravelStrategy = {
  stopsFor(commitLog: readonly CommitBundle[], executionTree?: StageSnapshot) {
    return executionTree && Object.keys(executionTree.logs).length > 0 ? commitStops(commitLog, executionTree) : [];
  },
};

/** 9.18.0's arrow, contextually typed: it hands the tree on and reads nothing else. */
export const arrow: TimeTravelStrategy = { stopsFor: (log, tree) => commitStops(log, tree) };

// ── The Lens: a stored tree cast to the strategy's parameter type ──────────

declare const stored: { commitLog?: unknown; executionTree?: unknown };
export const storedTree = stored.executionTree as Parameters<TimeTravelStrategy['stopsFor']>[1];
export const storedStops = tagStops().stopsFor([], storedTree);
