/**
 * NodeResolver — DFS node lookup + subflow reference resolution.
 *
 * Responsibilities:
 * - Find nodes by ID via recursive depth-first search (for back-edge/loop support)
 * - Resolve subflow reference nodes to actual subflow structures
 * - Evaluate deciders to determine next node in branching scenarios
 */

import type { StageContext } from '../../memory/StageContext.js';
import type { StageNode } from '../graph/StageNode.js';
import type { HandlerDeps } from '../types.js';

export class NodeResolver<TOut = any, TScope = any> {
  private readonly nodeIdMap: Map<string, StageNode<TOut, TScope>>;

  constructor(private deps: HandlerDeps<TOut, TScope>, nodeIdMap?: Map<string, StageNode<TOut, TScope>>) {
    this.nodeIdMap = nodeIdMap ?? new Map();
  }

  /**
   * O(1) node lookup via pre-built ID map.
   * Falls back to DFS from startNode (for dynamic nodes added at runtime
   * or subflow-local lookups that use an explicit startNode).
   */
  findNodeById(nodeId: string, startNode?: StageNode<TOut, TScope>): StageNode<TOut, TScope> | undefined {
    // Fast path: O(1) map lookup (only valid for root-level graph, not subflow-local)
    if (!startNode) {
      const mapped = this.nodeIdMap.get(nodeId);
      if (mapped) return mapped;
    }

    // Fallback: DFS from startNode (subflow-local or dynamic nodes not in the map)
    return this._dfs(nodeId, startNode ?? this.deps.root);
  }

  /**
   * DFS search for a node by ID.
   * Used as fallback when the node is not in the pre-built map.
   */
  private _dfs(nodeId: string, node: StageNode<TOut, TScope>): StageNode<TOut, TScope> | undefined {
    if (node.id === nodeId) return node;

    if (node.children) {
      for (const child of node.children) {
        const found = this._dfs(nodeId, child);
        if (found) return found;
      }
    }

    if (node.next) {
      const found = this._dfs(nodeId, node.next);
      if (found) return found;
    }

    return undefined;
  }

  /**
   * Resolve a subflow reference node to its actual structure.
   *
   * Reference nodes are lightweight placeholders (isSubflowRoot but no fn/children).
   * The actual structure lives in the subflows dictionary.
   */
  resolveSubflowReference(node: StageNode<TOut, TScope>): StageNode<TOut, TScope> {
    // Already has structure — not a reference
    if (node.fn || (node.children && node.children.length > 0)) return node;

    if (!this.deps.subflows) return node;

    // Try multiple keys in order of preference
    const keysToTry = [node.subflowId, node.subflowName, node.name].filter(Boolean) as string[];
    let subflowDef: { root: StageNode<TOut, TScope> } | undefined;

    for (const key of keysToTry) {
      if (this.deps.subflows[key]) {
        subflowDef = this.deps.subflows[key];
        break;
      }
    }

    if (!subflowDef) {
      this.deps.logger.info(
        `Subflow not found in dictionary for node '${node.name}' (tried keys: ${keysToTry.join(', ')})`,
      );
      return node;
    }

    // Merge reference metadata with actual structure.
    // id comes from the inner root (the actual stage identity for trace matching),
    // not the mount node (which is the subflow entry point in the parent).
    return {
      ...subflowDef.root,
      isSubflowRoot: node.isSubflowRoot,
      subflowId: node.subflowId,
      subflowName: node.subflowName,
      id: subflowDef.root.id || node.id,
      subflowMountOptions: node.subflowMountOptions || subflowDef.root.subflowMountOptions,
    };
  }
}
