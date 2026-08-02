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
 *
 * The FORWARD half has exactly the same hazard and the same two projections:
 * {@link forwardSliceToJSON} / {@link formatForwardSlice}. A forward DAG
 * shares nodes just as readily — two values read by one stage feed the same
 * child write — so a forward root must never be stringified either.
 *
 * {@link KeyTimeline} is the deliberate exception, stated so nobody adds a
 * pointless twin: it is a FLAT list of plain fields holding no live
 * references and no sharing, so `JSON.stringify(timeline)` is already
 * correct and linear. What it still needs is the bounded LLM projection —
 * {@link formatTimeline} — because "the whole life of a key" is unbounded in
 * a long run.
 */

import { flattenCausalDAG, formatCausalChain } from '../memory/backtrack.js';
import type {
  ForwardNode,
  ForwardSlice,
  ForwardSliceJSON,
  HonestyNote,
  KeyTimeline,
  SliceJSON,
  VariableSlice,
} from './types.js';

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

// ── Forward projections ───────────────────────────────────────────────────

/** How many reads one node lists before the renderer says "… and N more". */
const READS_RENDERED = 5;

/** BFS over the forward DAG, each node exactly once (shared nodes included). */
function flattenForwardDAG(root: ForwardNode): ForwardNode[] {
  const out: ForwardNode[] = [];
  const seen = new Set<ForwardNode>();
  const queue: ForwardNode[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (seen.has(node)) continue;
    seen.add(node);
    out.push(node);
    for (const edge of node.fedEdges) if (!seen.has(edge.child)) queue.push(edge.child);
  }
  return out;
}

/** `⚠ …` lines for the honesty envelope — same rendering for both doors. */
function noteLines(notes: HonestyNote[]): string[] {
  return notes.map((n) => `⚠ ${n.detail}`);
}

/** One node's headline: who wrote the value, and how long it lived. */
function nodeHeadline(node: ForwardNode): string {
  const life =
    node.nextWriteIdx !== undefined ? `live until commit ${node.nextWriteIdx}` : 'live to the end of the run';
  if (node.origin === 'pre-run') {
    return `'${node.key}' from BEFORE the run (initial state / input / closure) — ${life}`;
  }
  return `'${node.key}' ${node.verb ?? 'set'} by ${node.stageName} (${node.runtimeStageId}) @${
    node.commitIdx
  } — ${life}`;
}

/**
 * Flat, JSON-safe projection of a {@link ForwardSlice} — the forward twin of
 * {@link sliceToJSON}, linear in node count.
 *
 * Node ids are OPAQUE (`n0`, `n1`, … in BFS order) rather than
 * `runtimeStageId` as in `SliceJSON`, for a structural reason: a forward
 * node is a (key, write) pair, so ONE stage that wrote two keys owns two
 * nodes and a runtimeStageId cannot key the map. Never parse the ids — join
 * on `runtimeStageId` / `commitIdx` / `key`, which every node carries.
 */
export function forwardSliceToJSON(slice: ForwardSlice): ForwardSliceJSON {
  const out: ForwardSliceJSON = {
    key: slice.key,
    ...(slice.before !== undefined && { before: slice.before }),
    ...(slice.missing !== undefined && { missing: slice.missing }),
    keysReadKind: slice.keysReadKind,
    ...(slice.readsCoverage !== undefined && { readsCoverage: slice.readsCoverage }),
    notes: slice.notes,
  };
  if (!slice.root) return out;

  const flat = flattenForwardDAG(slice.root);
  const ids = new Map<ForwardNode, string>();
  flat.forEach((node, i) => ids.set(node, `n${i}`));

  out.rootId = ids.get(slice.root);
  out.nodes = flat.map((node) => ({
    id: ids.get(node)!,
    key: node.key,
    origin: node.origin,
    ...(node.runtimeStageId !== undefined && { runtimeStageId: node.runtimeStageId }),
    ...(node.stageId !== undefined && { stageId: node.stageId }),
    ...(node.stageName !== undefined && { stageName: node.stageName }),
    ...(node.commitIdx !== undefined && { commitIdx: node.commitIdx }),
    ...(node.verb !== undefined && { verb: node.verb }),
    ...(node.nextWriteIdx !== undefined && { nextWriteIdx: node.nextWriteIdx }),
    depth: node.depth,
    reads: node.reads,
    ...(node.incompleteSources !== undefined && { incompleteSources: node.incompleteSources }),
  }));
  out.edges = flat.flatMap((node) =>
    node.fedEdges.map((edge) => ({ from: ids.get(node)!, to: ids.get(edge.child)!, basis: edge.basis })),
  );
  if (slice.root.truncated) out.truncated = slice.root.truncated;
  return out;
}

/**
 * One bounded string for LLM triage tools — the forward twin of
 * {@link formatSlice}. Shared nodes render once (`↳ … (see above)`, the same
 * convention `formatCausalChain` uses), read lists are capped, and every
 * honesty note renders as a `⚠` line — including the one that says a `fed`
 * edge is conservative, which is why edges print `[exact]` / `[conservative]`
 * rather than looking alike.
 */
export function formatForwardSlice(slice: ForwardSlice): string {
  const lines: string[] = [];
  const anchor = slice.before !== undefined ? ` (as of before commit ${slice.before})` : '';
  lines.push(`FORWARD SLICE for '${slice.key}'${anchor} — reads via: ${slice.keysReadKind}`);

  if (slice.missing === 'empty-log') {
    lines.push('no forward slice: the commit log is empty (nothing has executed).');
    return [...lines, ...noteLines(slice.notes)].join('\n');
  }
  if (slice.missing === 'never-written') {
    lines.push(`no forward slice: '${slice.key}' was never written and never read in this log.`);
    return [...lines, ...noteLines(slice.notes)].join('\n');
  }

  const seen = new Set<ForwardNode>();
  const walk = (node: ForwardNode, indent: number, lead = ''): void => {
    const pad = '  '.repeat(indent);
    const head = `${pad}${lead}${nodeHeadline(node)}`;
    if (seen.has(node)) {
      lines.push(`${head} ↳ (see above)`);
      return;
    }
    seen.add(node);
    lines.push(head);
    if (node.incompleteSources && node.incompleteSources.length > 0) {
      lines.push(`${pad}  ⚠ its writer also consumed ${node.incompleteSources.join('/')} — untracked`);
    }
    if (node.reads.length === 0) {
      lines.push(`${pad}  (no recorded read of this value)`);
    }
    for (const read of node.reads.slice(0, READS_RENDERED)) {
      lines.push(`${pad}  read by ${read.stageName} (${read.runtimeStageId}) @${read.commitIdx}`);
    }
    if (node.reads.length > READS_RENDERED) {
      lines.push(`${pad}  … and ${node.reads.length - READS_RENDERED} more reads`);
    }
    for (const edge of node.fedEdges) {
      walk(edge.child, indent + 1, `→ fed ${edge.basis === 'per-write' ? '[exact]' : '[conservative]'} `);
    }
  };
  if (slice.root) walk(slice.root, 0);

  return [...lines, ...noteLines(slice.notes)].join('\n');
}

/** How many moments {@link formatTimeline} renders before it says "… and N more". */
const MOMENTS_RENDERED = 60;

/**
 * One bounded string for a {@link KeyTimeline} — the LLM/human projection.
 * (The timeline's JSON needs no helper: it is already flat and JSON-safe —
 * see the file header.) Truncation is stated, never silent.
 */
export function formatTimeline(timeline: KeyTimeline): string {
  const lines: string[] = [];
  const bound = timeline.before !== undefined ? ` (before commit ${timeline.before})` : '';
  lines.push(`TIMELINE for '${timeline.key}'${bound} — reads via: ${timeline.keysReadKind}`);

  if (timeline.missing === 'empty-log') {
    lines.push('no timeline: the commit log is empty (nothing has executed).');
    return [...lines, ...noteLines(timeline.notes)].join('\n');
  }
  if (timeline.missing === 'never-written') {
    lines.push(`no timeline: '${timeline.key}' was never written and never read in this log.`);
    return [...lines, ...noteLines(timeline.notes)].join('\n');
  }

  const moments = timeline.moments ?? [];
  if (moments.length === 0) lines.push('(no recorded moment for this key)');
  for (const moment of moments.slice(0, MOMENTS_RENDERED)) {
    const where = `${moment.stageName} (${moment.runtimeStageId})`;
    if (moment.kind === 'write') {
      lines.push(`@${moment.commitIdx} write ${moment.verb ?? 'set'} — ${where}`);
    } else {
      const from =
        moment.fromWriteIdx !== undefined ? `value from commit ${moment.fromWriteIdx}` : 'value from BEFORE the run';
      lines.push(`@${moment.commitIdx} read  — ${where} (${from})`);
    }
  }
  if (moments.length > MOMENTS_RENDERED) {
    lines.push(`… and ${moments.length - MOMENTS_RENDERED} more moments (bounded output)`);
  }

  return [...lines, ...noteLines(timeline.notes)].join('\n');
}
