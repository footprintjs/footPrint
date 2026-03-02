/**
 * RuntimeStructureManager - Manages the mutable runtime pipeline structure
 *
 * WHY: During execution, dynamic events (new children, subflows, next chains,
 * loop iterations) modify the pipeline. This manager keeps a serialized
 * structure in sync so consumers get the complete picture without
 * reconstructing it from runtime data.
 *
 * DESIGN: Deep-clones the build-time structure at initialization, then
 * maintains an O(1) lookup map for fast updates during execution.
 *
 * RELATED:
 * - {@link Pipeline} - Delegates structure tracking here
 * - {@link FlowChartBuilder} - Produces the build-time structure
 */

import type { SerializedPipelineStructure } from '../../builder/FlowChartBuilder';
import type { StageNode } from '../Pipeline';

/**
 * Compute the node type based on node properties.
 *
 * WHY: Both the structure manager (for serialization) and the extractor
 * (for metadata) need the same type computation. Extracted as a pure
 * function to avoid duplication.
 */
export function computeNodeType(node: StageNode): 'stage' | 'decider' | 'fork' | 'streaming' {
  if (node.nextNodeDecider || node.nextNodeSelector || node.deciderFn) return 'decider';
  if (node.isStreaming) return 'streaming';

  const hasDynamicChildren = Boolean(
    node.children?.length &&
    !node.nextNodeDecider &&
    !node.nextNodeSelector &&
    node.fn
  );
  if (node.children && node.children.length > 0 && !hasDynamicChildren) return 'fork';

  return 'stage';
}

export class RuntimeStructureManager {
  private runtimePipelineStructure?: SerializedPipelineStructure;
  private structureNodeMap: Map<string, SerializedPipelineStructure> = new Map();

  /**
   * Initialize from the build-time structure.
   * Deep-clones via JSON round-trip (safe for JSON-only values).
   */
  init(buildTimeStructure?: SerializedPipelineStructure): void {
    if (!buildTimeStructure) return;
    this.runtimePipelineStructure = JSON.parse(JSON.stringify(buildTimeStructure));
    this.buildNodeMap(this.runtimePipelineStructure!);
  }

  /** Returns the current runtime structure (mutated during execution). */
  getStructure(): SerializedPipelineStructure | undefined {
    return this.runtimePipelineStructure;
  }

  // ──────────────────────── Node map ────────────────────────

  /**
   * Recursively registers all nodes in the O(1) lookup map.
   * Keys are node IDs (preferred) or names (fallback).
   */
  private buildNodeMap(node: SerializedPipelineStructure): void {
    const key = node.id ?? node.name;
    this.structureNodeMap.set(key, node);

    if (node.children) {
      for (const child of node.children) {
        this.buildNodeMap(child);
      }
    }
    if (node.next) {
      this.buildNodeMap(node.next);
    }
    if (node.subflowStructure) {
      this.buildNodeMap(node.subflowStructure);
    }
  }

  // ──────────────────────── Conversion ────────────────────────

  /**
   * Converts a runtime StageNode into a SerializedPipelineStructure node.
   * Recursively handles children, next chains, and subflow structures.
   */
  stageNodeToStructure(node: StageNode): SerializedPipelineStructure {
    const structure: SerializedPipelineStructure = {
      name: node.name,
      id: node.id,
      type: computeNodeType(node),
      displayName: node.displayName,
      description: node.description,
    };

    if (node.isStreaming) {
      structure.isStreaming = true;
      structure.streamId = node.streamId;
    }

    if (node.isSubflowRoot) {
      structure.isSubflowRoot = true;
      structure.subflowId = node.subflowId;
      structure.subflowName = node.subflowName;
    }

    if (node.nextNodeDecider || node.deciderFn) {
      structure.hasDecider = true;
      structure.branchIds = node.children?.map(c => c.id ?? c.name);
    }

    if (node.nextNodeSelector) {
      structure.hasSelector = true;
      structure.branchIds = node.children?.map(c => c.id ?? c.name);
    }

    if (node.children?.length) {
      structure.children = node.children.map(c => this.stageNodeToStructure(c));
    }

    if (node.next) {
      structure.next = this.stageNodeToStructure(node.next);
    }

    if (node.subflowDef?.buildTimeStructure) {
      structure.subflowStructure = node.subflowDef.buildTimeStructure as SerializedPipelineStructure;
    }

    return structure;
  }

  // ──────────────────────── Dynamic updates ────────────────────────

  /**
   * Updates the structure when dynamic children are discovered at runtime.
   */
  updateDynamicChildren(
    parentNodeId: string,
    dynamicChildren: StageNode[],
    hasSelector?: boolean,
    hasDecider?: boolean,
  ): void {
    if (!this.runtimePipelineStructure) return;

    const parentStructure = this.structureNodeMap.get(parentNodeId);
    if (!parentStructure) {
      // eslint-disable-next-line no-console
      console.warn(
        `[RuntimeStructureManager] updateDynamicChildren: parent "${parentNodeId}" not found`,
      );
      return;
    }

    const childStructures = dynamicChildren.map(child => this.stageNodeToStructure(child));
    parentStructure.children = childStructures;

    for (const childStructure of childStructures) {
      this.buildNodeMap(childStructure);
    }

    if (hasSelector) {
      parentStructure.hasSelector = true;
      parentStructure.branchIds = childStructures.map(c => c.id ?? c.name);
    }

    if (hasDecider) {
      parentStructure.hasDecider = true;
      parentStructure.branchIds = childStructures.map(c => c.id ?? c.name);
    }
  }

  /**
   * Updates the structure when a dynamic subflow is registered at runtime.
   */
  updateDynamicSubflow(
    mountNodeId: string,
    subflowId: string,
    subflowName?: string,
    subflowBuildTimeStructure?: unknown,
  ): void {
    if (!this.runtimePipelineStructure) return;

    const mountStructure = this.structureNodeMap.get(mountNodeId);
    if (!mountStructure) {
      // eslint-disable-next-line no-console
      console.warn(
        `[RuntimeStructureManager] updateDynamicSubflow: mount "${mountNodeId}" not found`,
      );
      return;
    }

    mountStructure.isSubflowRoot = true;
    mountStructure.subflowId = subflowId;

    if (subflowName !== undefined) {
      mountStructure.subflowName = subflowName;
    }

    if (subflowBuildTimeStructure) {
      mountStructure.subflowStructure = subflowBuildTimeStructure as SerializedPipelineStructure;
      this.buildNodeMap(mountStructure.subflowStructure);
    }
  }

  /**
   * Updates the structure when a dynamic next chain is discovered at runtime.
   */
  updateDynamicNext(
    currentNodeId: string,
    dynamicNext: StageNode,
  ): void {
    if (!this.runtimePipelineStructure) return;

    const currentStructure = this.structureNodeMap.get(currentNodeId);
    if (!currentStructure) {
      // eslint-disable-next-line no-console
      console.warn(
        `[RuntimeStructureManager] updateDynamicNext: node "${currentNodeId}" not found`,
      );
      return;
    }

    const nextStructure = this.stageNodeToStructure(dynamicNext);
    currentStructure.next = nextStructure;
    this.buildNodeMap(nextStructure);
  }

  /**
   * Updates the iteration count for a node (loop support).
   */
  updateIterationCount(nodeId: string, count: number): void {
    if (!this.runtimePipelineStructure) return;
    const nodeStructure = this.structureNodeMap.get(nodeId);
    if (!nodeStructure) return;
    nodeStructure.iterationCount = count;
  }
}
