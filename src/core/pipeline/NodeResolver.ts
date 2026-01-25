/**
 * NodeResolver.ts
 *
 * Handles node lookup and subflow reference resolution for the Pipeline.
 * Extracted from Pipeline.ts to follow Single Responsibility Principle.
 *
 * Responsibilities:
 * - Find nodes by ID (recursive tree search)
 * - Resolve subflow reference nodes to actual subflow structures
 * - Evaluate deciders to determine next node
 *
 * _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_
 */

import { StageContext } from '../context/StageContext';
import { logger } from '../logger';
import { PipelineContext } from './types';
import type { StageNode, Decider } from './GraphTraverser';

/**
 * NodeResolver
 * ------------------------------------------------------------------
 * Handles node lookup and subflow reference resolution.
 * Uses PipelineContext for access to root node and subflows dictionary.
 *
 * @template TOut - Output type of pipeline stages
 * @template TScope - Scope type passed to stages
 */
export class NodeResolver<TOut = any, TScope = any> {
  constructor(private ctx: PipelineContext<TOut, TScope>) {}

  /**
   * Find a node by its ID in the tree (recursive search).
   * Used by dynamicNext to loop back to existing nodes.
   *
   * @param nodeId - The ID of the node to find
   * @param startNode - The node to start searching from (defaults to root)
   * @returns The found node, or undefined if not found
   *
   * _Requirements: 3.1, 3.4_
   */
  findNodeById(nodeId: string, startNode?: StageNode<TOut, TScope>): StageNode<TOut, TScope> | undefined {
    const node = startNode ?? this.ctx.root;

    // Check current node
    if (node.id === nodeId) {
      return node;
    }

    // Check children
    if (node.children) {
      for (const child of node.children) {
        const found = this.findNodeById(nodeId, child);
        if (found) return found;
      }
    }

    // Check next
    if (node.next) {
      const found = this.findNodeById(nodeId, node.next);
      if (found) return found;
    }

    return undefined;
  }

  /**
   * Resolve a subflow reference node to its actual subflow structure.
   *
   * Reference nodes are lightweight placeholders created by the builder:
   * - They have `isSubflowRoot: true` and `subflowId`
   * - But they have NO `fn`, NO `children`, NO internal `next`
   * - The actual subflow structure is in `this.ctx.subflows[subflowKey]`
   *
   * This method looks up the subflow definition and creates a merged node
   * that combines the reference metadata with the actual subflow structure.
   *
   * @param node - The reference node to resolve
   * @returns A node with the subflow's actual structure, preserving reference metadata
   *
   * _Requirements: 3.2, 3.5_
   */
  resolveSubflowReference(node: StageNode<TOut, TScope>): StageNode<TOut, TScope> {
    // If node already has fn or children, it's not a reference - return as-is
    if (node.fn || (node.children && node.children.length > 0)) {
      return node;
    }

    // Check if we have subflows dictionary
    if (!this.ctx.subflows) {
      // No subflows dictionary - node might be using old deep-copy approach
      return node;
    }

    // Try to find subflow definition using multiple keys in order of preference:
    // 1. subflowId (the mount id, used by FlowChartBuilder)
    // 2. subflowName (for backward compatibility)
    // 3. name (fallback)
    const keysToTry = [node.subflowId, node.subflowName, node.name].filter(Boolean) as string[];
    let subflowDef: { root: StageNode<TOut, TScope> } | undefined;

    for (const key of keysToTry) {
      if (this.ctx.subflows[key]) {
        subflowDef = this.ctx.subflows[key];
        break;
      }
    }

    if (!subflowDef) {
      // Subflow not found in dictionary - might be using old approach
      logger.info(
        `Subflow not found in subflows dictionary for node '${node.name}' (tried keys: ${keysToTry.join(', ')})`,
      );
      return node;
    }

    // Create a merged node that combines reference metadata with actual structure
    // IMPORTANT: We preserve the reference node's metadata (subflowId, subflowName, etc.)
    // but use the subflow definition's structure (fn, children, internal next)
    const resolvedNode: StageNode<TOut, TScope> = {
      ...subflowDef.root,
      // Preserve reference metadata
      isSubflowRoot: node.isSubflowRoot,
      subflowId: node.subflowId,
      subflowName: node.subflowName,
      // Use reference node's display name if provided
      displayName: node.displayName || subflowDef.root.displayName,
      // Use reference node's id (mountId) for uniqueness
      id: node.id || subflowDef.root.id,
    };

    return resolvedNode;
  }

  /**
   * Evaluate decider and pick the next child by id; throws if not found.
   *
   * @param nextNodeDecider - The decider function to evaluate
   * @param children - Array of child nodes to choose from
   * @param input - Input to pass to the decider
   * @param context - Optional stage context for debug info
   * @returns The chosen child node
   * @throws Error if the decider returns an ID that doesn't match any child
   *
   * _Requirements: 3.3_
   */
  async getNextNode(
    nextNodeDecider: Decider,
    children: StageNode<TOut, TScope>[],
    input?: TOut,
    context?: StageContext,
  ): Promise<StageNode<TOut, TScope>> {
    const deciderResp = nextNodeDecider(input);
    const nextNodeId = deciderResp instanceof Promise ? await deciderResp : deciderResp;

    context?.addDebugInfo('nextNode', nextNodeId);

    const nextNode = children.find((child) => child.id === nextNodeId);
    if (!nextNode) {
      const errorMessage = `Next Stage not found for ${nextNodeId}`;
      context?.addErrorInfo('deciderError', errorMessage);
      throw Error(errorMessage);
    }
    return nextNode;
  }
}
