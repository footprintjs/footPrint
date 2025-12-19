/**
 * RuntimeStructureManager — Mutable structure tracking for visualization.
 *
 * During execution, dynamic events (new children, subflows, next chains,
 * loop iterations) modify the pipeline. This manager keeps a serialized
 * structure in sync so consumers get the complete picture.
 *
 * Deep-clones build-time structure at init, then maintains O(1) lookup map.
 */

import type { SerializedPipelineStructure } from '../types';
import type { StageNode } from '../graph/StageNode';

/**
 * Compute the node type from node properties.
 * Shared by RuntimeStructureManager (serialization) and ExtractorRunner (metadata).
 */
export function computeNodeType(node: StageNode): 'stage' | 'decider' | 'fork' | 'streaming' {
  if (node.nextNodeSelector || node.deciderFn || node.selectorFn) return 'decider';
  if (node.isStreaming) return 'streaming';

  const hasDynamicChildren = Boolean(
    node.children?.length &&
    !node.nextNodeSelector &&
    node.fn,
  );
  if (node.children && node.children.length > 0 && !hasDynamicChildren) return 'fork';

  return 'stage';
}

export class RuntimeStructureManager {
  private runtimePipelineStructure?: SerializedPipelineStructure;
  private structureNodeMap: Map<string, SerializedPipelineStructure> = new Map();

  /** Initialize from build-time structure. Deep-clones via JSON round-trip. */
  init(buildTimeStructure?: SerializedPipelineStructure): void {
    if (!buildTimeStructure) return;
    this.runtimePipelineStructure = JSON.parse(JSON.stringify(buildTimeStructure));
    this.buildNodeMap(this.runtimePipelineStructure!);
  }

  /** Returns the current runtime structure (mutated during execution). */
  getStructure(): SerializedPipelineStructure | undefined {
    return this.runtimePipelineStructure;
  }

  /** Recursively registers all nodes in the O(1) lookup map. */
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

  /** Convert a runtime StageNode into a SerializedPipelineStructure node. */
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

    if (node.deciderFn) {
      structure.hasDecider = true;
      structure.branchIds = node.children?.map((c) => c.id ?? c.name);
    }

    if (node.nextNodeSelector) {
      structure.hasSelector = true;
      structure.branchIds = node.children?.map((c) => c.id ?? c.name);
    }

    if (node.children?.length) {
      structure.children = node.children.map((c) => this.stageNodeToStructure(c));
    }

    if (node.next) {
      structure.next = this.stageNodeToStructure(node.next);
    }

    if (node.subflowDef?.buildTimeStructure) {
      structure.subflowStructure = node.subflowDef.buildTimeStructure as SerializedPipelineStructure;
    }

    return structure;
  }

  /** Update structure when dynamic children are discovered at runtime. */
  updateDynamicChildren(
    parentNodeId: string,
    dynamicChildren: StageNode[],
    hasSelector?: boolean,
    hasDecider?: boolean,
  ): void {
    if (!this.runtimePipelineStructure) return;

    const parentStructure = this.structureNodeMap.get(parentNodeId);
    if (!parentStructure) return;

    const childStructures = dynamicChildren.map((child) => this.stageNodeToStructure(child));
    parentStructure.children = childStructures;

    for (const childStructure of childStructures) {
      this.buildNodeMap(childStructure);
    }

    if (hasSelector) {
      parentStructure.hasSelector = true;
      parentStructure.branchIds = childStructures.map((c) => c.id ?? c.name);
    }

    if (hasDecider) {
      parentStructure.hasDecider = true;
      parentStructure.branchIds = childStructures.map((c) => c.id ?? c.name);
    }
  }

  /** Update structure when a dynamic subflow is registered at runtime. */
  updateDynamicSubflow(
    mountNodeId: string,
    subflowId: string,
    subflowName?: string,
    subflowBuildTimeStructure?: unknown,
  ): void {
    if (!this.runtimePipelineStructure) return;

    const mountStructure = this.structureNodeMap.get(mountNodeId);
    if (!mountStructure) return;

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

  /** Update structure when a dynamic next chain is discovered at runtime. */
  updateDynamicNext(currentNodeId: string, dynamicNext: StageNode): void {
    if (!this.runtimePipelineStructure) return;

    const currentStructure = this.structureNodeMap.get(currentNodeId);
    if (!currentStructure) return;

    const nextStructure = this.stageNodeToStructure(dynamicNext);
    currentStructure.next = nextStructure;
    this.buildNodeMap(nextStructure);
  }

  /** Update the iteration count for a node (loop support). */
  updateIterationCount(nodeId: string, count: number): void {
    if (!this.runtimePipelineStructure) return;
    const nodeStructure = this.structureNodeMap.get(nodeId);
    if (!nodeStructure) return;
    nodeStructure.iterationCount = count;
  }
}
