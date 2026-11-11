/**
 * ManifestFlowRecorder — Builds a lightweight subflow manifest during traversal.
 *
 * Collects subflow metadata (ID, name, description) as a side effect of
 * observing traversal events. Produces a tree structure suitable for LLM
 * navigation: lightweight enough to include in snapshots, with on-demand
 * access to full specs via getSpec().
 *
 * The manifest reflects only subflows that were actually entered during
 * execution — unvisited branches are not included.
 *
 * Attempts (10.1): a stage whose retry series retried, gave up or timed out gets a row —
 * `{ stageId, stageName, runtimeStageId, attempts: AttemptSummary }` — on the
 * entry of the subflow it ran in (`ManifestEntry.attempts`). The manifest has
 * no entry for the top-level chart, so a top-level stage's row (or one whose
 * subflow entry this recorder never saw) is served by `getRootAttempts()` and
 * rides the snapshot bundle's `meta.rootAttempts` (absent when empty — the
 * bundle's `data` keeps its shape).
 *
 * @example
 * ```typescript
 * const manifest = new ManifestFlowRecorder();
 * executor.attachFlowRecorder(manifest);
 * await executor.run({ input: data });
 *
 * // Lightweight tree of subflow IDs + descriptions
 * const tree = manifest.getManifest();
 *
 * // Full spec for a specific subflow (if available)
 * const spec = manifest.getSpec('sf-credit-check');
 * ```
 */

import { joinPath, subflowSegmentsOf } from 'foottrace';

import type { AttemptSummary } from '../../../attempt/types.js';
import { AttemptSeriesBook, subflowOfAttempt } from '../../../recorder/attemptSeries.js';
import type { FlowAttemptEvent, FlowRecorder, FlowSubflowEvent, FlowSubflowRegisteredEvent } from '../types.js';

/** One stage execution whose retry series retried, gave up or timed out, at a glance. */
export interface ManifestAttemptRow {
  /** Stable stage id (path-prefixed inside a subflow). */
  stageId: string;
  stageName: string;
  /** The execution — the series' `runtimeStageId`. */
  runtimeStageId: string;
  /** The series at a glance — equal to the stage's `StageSnapshot.attemptSummary`. */
  attempts: AttemptSummary;
}

/** A single entry in the subflow manifest tree. */
export interface ManifestEntry {
  /** Subflow identifier — use for on-demand spec lookup. */
  subflowId: string;
  /** Human-readable name. */
  name: string;
  /** Build-time description of what this subflow does. */
  description?: string;
  /** Nested subflows entered within this subflow. */
  children: ManifestEntry[];
  /** Stages run directly in this subflow whose series retried, gave up or timed out — absent when none did. */
  attempts?: ManifestAttemptRow[];
}

export class ManifestFlowRecorder implements FlowRecorder {
  readonly id: string;

  /** Open entries in entry order — the last one is the most recently entered. */
  private stack: ManifestEntry[] = [];
  /** The entry each open entry is nested in (absent for a root). Recorded at entry. */
  private parents = new Map<ManifestEntry, ManifestEntry>();
  /** Root-level subflows (not nested inside another subflow). */
  private roots: ManifestEntry[] = [];
  /** Full specs stored from dynamic registration events. */
  private specs = new Map<string, unknown>();
  /**
   * Open entries by subflowId — where a stage's row lands. Not the stack: parallel subflow siblings exit out of
   * stack order, so the entry a row belongs to may no longer be on it.
   */
  private openEntries = new Map<string, ManifestEntry>();
  /** Rows of top-level stages — the manifest has no entry for the top-level chart. */
  private rootAttempts: ManifestAttemptRow[] = [];
  /** Per-series tallies of the series that retried, gave up or timed out. */
  private readonly attemptBook = new AttemptSeriesBook();

  constructor(id?: string) {
    this.id = id ?? 'manifest';
  }

  /**
   * The parent is the open entry of the subflow the mount stage ran in, read from the mount's
   * `runtimeStageId`, so parallel sibling subflows are never nested under each other. An event
   * without a traversal context nests under the most recently entered open entry.
   */
  onSubflowEntry(event: FlowSubflowEvent): void {
    const entry: ManifestEntry = {
      subflowId: event.subflowId ?? event.name,
      name: event.name,
      description: event.description,
      children: [],
    };
    const mount = event.traversalContext?.runtimeStageId;
    const parent =
      mount === undefined
        ? this.stack[this.stack.length - 1]
        : this.openEntries.get(joinPath(...subflowSegmentsOf(mount)));
    if (parent) this.parents.set(entry, parent);
    this.stack.push(entry);
    this.openEntries.set(entry.subflowId, entry);
  }

  /** Closes the open entry of the exiting subflow (the most recently entered one when no entry matches it). */
  onSubflowExit(event: FlowSubflowEvent): void {
    const key = event.subflowId ?? event.name;
    const matched = this.openEntries.get(key);
    const index = matched ? this.stack.lastIndexOf(matched) : this.stack.length - 1;
    if (index < 0) return;
    const [completed] = this.stack.splice(index, 1);
    if (this.openEntries.get(completed.subflowId) === completed) this.openEntries.delete(completed.subflowId);

    const parent = this.parents.get(completed);
    this.parents.delete(completed);
    if (parent) {
      parent.children.push(completed);
    } else {
      this.roots.push(completed);
    }
  }

  /**
   * A series' row lands once, when it ends, on the open entry of the subflow the stage ran in; a top-level
   * stage's (or one whose entry this recorder never saw) on the root rows.
   */
  onAttempt(event: FlowAttemptEvent): void {
    const summary = this.attemptBook.add(event.record)?.summary;
    if (!summary) return;
    const row: ManifestAttemptRow = {
      stageId: event.stageId,
      stageName: event.stageName,
      runtimeStageId: event.record.series,
      attempts: summary,
    };
    const owner = this.openEntries.get(subflowOfAttempt(event) ?? '');
    // A row whose subflow entry this recorder never saw (attached mid-run) is kept with the top-level rows — its
    // path-prefixed `stageId` still says where it ran — never dropped.
    if (owner) (owner.attempts ??= []).push(row);
    else this.rootAttempts.push(row);
  }

  onSubflowRegistered(event: FlowSubflowRegisteredEvent): void {
    if (event.specStructure && !this.specs.has(event.subflowId)) {
      this.specs.set(event.subflowId, event.specStructure);
    }
  }

  /** Returns the manifest tree — lightweight, suitable for snapshot inclusion. */
  getManifest(): ManifestEntry[] {
    return [...this.roots];
  }

  /**
   * Rows of top-level stages whose series retried, gave up or timed out, in the order the series ended — plus any row of a
   * subflow stage whose entry this recorder never saw (its path-prefixed `stageId` says where it ran).
   */
  getRootAttempts(): ManifestAttemptRow[] {
    return [...this.rootAttempts];
  }

  /**
   * Returns the full spec for a dynamically-registered subflow.
   * Only populated for subflows auto-registered at runtime (via StageNode
   * return with subflowDef). Statically-configured subflows are not included
   * even if they appear in getManifest(). Use FlowChart.buildTimeStructure
   * to access statically-defined subflow specs.
   */
  getSpec(subflowId: string): unknown | undefined {
    return this.specs.get(subflowId);
  }

  /** Returns all stored spec IDs. */
  getSpecIds(): string[] {
    return Array.from(this.specs.keys());
  }

  toSnapshot() {
    return {
      name: 'Manifest',
      description: 'Translator (FlowRecorder) — subflow catalog built during traversal',
      preferredOperation: 'translate' as const,
      data: this.getManifest(),
      ...(this.rootAttempts.length > 0 && { meta: { rootAttempts: this.getRootAttempts() } }),
    };
  }

  /** Clears state for reuse. */
  clear(): void {
    this.stack = [];
    this.parents = new Map();
    this.roots = [];
    this.specs.clear();
    this.openEntries = new Map();
    this.rootAttempts = [];
    this.attemptBook.clear();
  }
}
