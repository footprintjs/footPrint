/**
 * NodeResolver.ts
 *
 * WHY: Handles node lookup and subflow reference resolution for the Pipeline.
 * This module is extracted from Pipeline.ts following the Single Responsibility Principle,
 * isolating the concerns of node resolution from pipeline traversal.
 *
 * RESPONSIBILITIES:
 * - Find nodes by ID (recursive tree search for loop-back support)
 * - Resolve subflow reference nodes to actual subflow structures
 * - Evaluate deciders to determine next node in branching scenarios
 *
 * DESIGN DECISIONS:
 * - Uses recursive tree search for findNodeById to handle arbitrary tree depths
 * - Subflow resolution uses multiple key fallbacks (subflowId, subflowName, name) for flexibility
 * - Decider evaluation is async-safe to support both sync and async decider functions
 *
 * RELATED:
 * - {@link Pipeline} - Uses NodeResolver for node lookup and subflow resolution
 * - {@link LoopHandler} - Uses findNodeById for loop-back to existing nodes
 * - {@link DeciderHandler} - Uses getNextNode for decider evaluation
 *
 */

import { StageContext } from '../../memory/StageContext';
import { logger } from '../../../utils/logger';
import { PipelineContext } from '../types';
import type { StageNode, Decider } from '../Pipeline';

/**
 * NodeResolver
 * ------------------------------------------------------------------
 * Handles node lookup and subflow reference resolution.
 *
 * WHY: Centralizes all node resolution logic in one place, making it easier
 * to understand and test how nodes are found and resolved during execution.
 *
 * DESIGN: Uses PipelineContext for access to root node and subflows dictionary,
 * enabling dependency injection for testing.
 *
 * @template TOut - Output type of pipeline stages
 * @template TScope - Scope type passed to stages
 *
 * @example
 * ```typescript
 * const resolver = new NodeResolver(pipelineContext);
 * const node = resolver.findNodeById('my-node-id');
 * const resolved = resolver.resolveSubflowReference(referenceNode);
 * ```
 */
export class NodeResolver<TOut = any, TScope = any> {
  constructor(private ctx: PipelineContext<TOut, TScope>) {}

  /**
   * Find a node by its ID in the tree (recursive search).
   *
   * WHY: Enables loop-back functionality where a stage can return a reference
   * to an existing node ID, causing execution to continue from that node.
   *
   * DESIGN: Uses depth-first search, checking current node, then children,
   * then next. This order ensures we find the first occurrence in tree order.
   *
   * @param nodeId - The ID of the node to find
   * @param startNode - The node to start searching from (defaults to root)
   * @returns The found node, or undefined if not found
   *
   */
  findNodeById(nodeId: string, startNode?: StageNode<TOut, TScope>): StageNode<TOut, TScope> | undefined {
    const node = startNode ?? this.ctx.root;

    // Check current node
    if (node.id === nodeId) {
      return node;
    }

    // Check children (depth-first)
    if (node.children) {
      for (const child of node.children) {
        const found = this.findNodeById(nodeId, child);
        if (found) return found;
      }
    }

    // Check next (linear continuation)
    if (node.next) {
      const found = this.findNodeById(nodeId, node.next);
      if (found) return found;
    }

    return undefined;
  }

  /**
   * Resolve a subflow reference node to its actual subflow structure.
   *
   * WHY: Reference-based subflows avoid deep-copying the entire subflow tree
   * at build time. Instead, they store a lightweight reference that is resolved
   * at runtime when the subflow is executed.
   *
   * DESIGN: Reference nodes are lightweight placeholders created by the builder:
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
    // WHY: Multiple fallbacks ensure compatibility with different builder versions
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
      // Preserve subflowMountOptions from the reference node (inputMapper/outputMapper)
      // WHY: The reference node carries the mount-time options (e.g., inputMapper
      // that injects tool arguments). The subflow definition doesn't have these.
      subflowMountOptions: node.subflowMountOptions || subflowDef.root.subflowMountOptions,
    };

    return resolvedNode;
  }

  /**
   * Evaluate decider and pick the next child by id.
   *
   * WHY: Deciders enable conditional branching where the next node is determined
   * at runtime based on the stage output or other conditions.
   *
   * DESIGN: Supports both sync and async decider functions by checking if the
   * result is a Promise before awaiting.
   *
   * @param nextNodeDecider - The decider function to evaluate
   * @param children - Array of child nodes to choose from
   * @param input - Input to pass to the decider (typically stage output)
   * @param context - Optional stage context for debug info
   * @returns The chosen child node
   * @throws Error if the decider returns an ID that doesn't match any child
   *
   */
  async getNextNode(
    nextNodeDecider: Decider,
    children: StageNode<TOut, TScope>[],
    input?: TOut,
    context?: StageContext,
  ): Promise<StageNode<TOut, TScope>> {
    const deciderResp = nextNodeDecider(input);
    const nextNodeId = deciderResp instanceof Promise ? await deciderResp : deciderResp;

    context?.addLog('nextNode', nextNodeId);

    const nextNode = children.find((child) => child.id === nextNodeId);
    if (!nextNode) {
      const errorMessage = `Next Stage not found for ${nextNodeId}`;
      context?.addError('deciderError', errorMessage);
      throw Error(errorMessage);
    }
    return nextNode;
  }
}
