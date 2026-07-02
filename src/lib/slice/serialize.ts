/**
 * slice/serialize.ts — JSON-safe and LLM-safe projections of a slice.
 *
 * WHY (the failure this prevents): `VariableSlice.root` is an in-memory DAG.
 * Nodes are SHARED — a diamond ancestor is one object reached through many
 * paths, and each node appears in both `parents` and `parentEdges[].parent`.
 * `JSON.stringify` knows nothing about sharing: it re-serializes every shared
 * subtree per path, which explodes combinatorially on diamond-heavy slices.
 * The two consumers that would naively stringify are exactly the ones this
 * library exists for — wire transfer (persist / send a slice) and LLM tools
 * (bounded context). Each gets a purpose-built projection:
 *
 * - {@link sliceToJSON}   — flat, id-referenced, LINEAR in node count.
 * - {@link formatSlice}   — one bounded human/LLM-readable string that also
 *   renders the honesty envelope (missing reason, reads coverage, truncation)
 *   a raw `formatCausalChain` doesn't know about.
 */

import { flattenCausalDAG, formatCausalChain } from '../memory/backtrack.js';
import type { SliceJSON, VariableSlice } from './types.js';

/**
 * Flat, JSON-safe projection: every DAG node exactly once (keyed by
 * runtimeStageId), edges as id references. Linear in node count — safe to
 * persist, send, or feed to structured consumers. Lossless for everything
 * except the in-memory object graph itself (rebuild adjacency from `edges`).
 */
export function sliceToJSON(slice: VariableSlice): SliceJSON {
  const out: SliceJSON = {
    key: slice.key,
    ...(slice.before !== undefined && { before: slice.before }),
    ...(slice.missing !== undefined && { missing: slice.missing }),
    keysReadKind: slice.keysReadKind,
    ...(slice.readsCoverage !== undefined && { readsCoverage: slice.readsCoverage }),
  };
  if (!slice.root) return out;

  out.writerId = slice.root.runtimeStageId;
  const nodes: NonNullable<SliceJSON['nodes']> = {};
  const edges: NonNullable<SliceJSON['edges']> = [];
  for (const node of flattenCausalDAG(slice.root)) {
    nodes[node.runtimeStageId] = {
      stageId: node.stageId,
      stageName: node.stageName,
      keysWritten: node.keysWritten,
      depth: node.depth,
      ...(node.incompleteSources !== undefined && { incompleteSources: node.incompleteSources }),
    };
    for (const edge of node.parentEdges) {
      edges.push({
        from: node.runtimeStageId,
        to: edge.parent.runtimeStageId,
        kind: edge.kind,
        ...(edge.key !== undefined && { key: edge.key }),
        weight: edge.weight,
      });
    }
  }
  out.nodes = nodes;
  out.edges = edges;
  if (slice.root.truncated) out.truncated = slice.root.truncated;
  return out;
}

/**
 * One bounded string for LLM triage tools (the `traceToolpack` consumption
 * pattern: tools return plain strings, never recursive objects). Wraps
 * `formatCausalChain` (which is budget-bounded by causalChain's
 * maxDepth/maxNodes and renders shared nodes once as `↳ … (see above)`),
 * and adds the honesty envelope the raw chain doesn't carry:
 *
 * - missing slices render their reason ("value came from initial state /
 *   frozen args / a closure — the commit log cannot see those"),
 * - a reads-less provider (`readTracking: 'off'` signature) renders an
 *   explicit "⚠ reads were not recorded" instead of silently showing an
 *   anchor with no dependencies,
 * - truncation footers pass through from formatCausalChain.
 */
export function formatSlice(slice: VariableSlice): string {
  const lines: string[] = [];
  const anchor = slice.before !== undefined ? ` (before commit ${slice.before})` : '';
  lines.push(`SLICE for '${slice.key}'${anchor} — reads via: ${slice.keysReadKind}`);

  if (slice.missing === 'empty-log') {
    lines.push('no slice: the commit log is empty (nothing has executed).');
    return lines.join('\n');
  }
  if (slice.missing === 'never-written') {
    lines.push(
      `no slice: '${slice.key}' was never written in range — the value came from ` +
        'initial state, frozen run input (args), or a closure; the commit log cannot see those.',
    );
    return lines.join('\n');
  }

  const cov = slice.readsCoverage;
  if (cov && cov.steps > 1 && cov.stepsWithReads === 0) {
    lines.push(
      "⚠ reads were not recorded (readTracking may be 'off') — dependencies below are " + 'unknowable, NOT absent.',
    );
  }
  if (slice.root) lines.push(formatCausalChain(slice.root));
  return lines.join('\n');
}
