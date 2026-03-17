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

import type { FlowRecorder, FlowSubflowEvent, FlowSubflowRegisteredEvent } from '../types.js';

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
}

export class ManifestFlowRecorder implements FlowRecorder {
  readonly id: string;

  /** Stack tracks nesting depth — current subflow is top of stack. */
  private stack: ManifestEntry[] = [];
  /** Root-level subflows (not nested inside another subflow). */
  private roots: ManifestEntry[] = [];
  /** Full specs stored from dynamic registration events. */
  private specs = new Map<string, unknown>();

  constructor(id?: string) {
    this.id = id ?? 'manifest';
  }

  onSubflowEntry(event: FlowSubflowEvent): void {
    const entry: ManifestEntry = {
      subflowId: event.subflowId ?? event.name,
      name: event.name,
      description: event.description,
      children: [],
    };
    this.stack.push(entry);
  }

  onSubflowExit(_event: FlowSubflowEvent): void {
    const completed = this.stack.pop();
    if (!completed) return;

    const parent = this.stack[this.stack.length - 1];
    if (parent) {
      parent.children.push(completed);
    } else {
      this.roots.push(completed);
    }
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

  /** Clears state for reuse. */
  clear(): void {
    this.stack = [];
    this.roots = [];
    this.specs.clear();
  }
}
