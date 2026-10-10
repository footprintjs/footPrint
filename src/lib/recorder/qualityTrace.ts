/**
 * qualityTrace() — Quality Stack Trace built on causalChain().
 *
 * Thin layer over `foottrace`'s `causalChain()` that decorates
 * each causal node with quality scores from a QualityRecorder.
 *
 * ```
 * Quality Trace (score: 0.3 at call-llm#5):
 *   at call-llm#5     score=0.3  ← quality dropped here
 *   at system-prompt#1 score=0.8  ← systemPrompt was good
 *   at seed#0          score=1.0  ← input was clean
 *
 * Root cause: quality dropped at call-llm#5 (0.8 → 0.3, Δ0.5)
 * ```
 */

import type { CommitBundle } from 'foottrace';
import { causalChain, flattenCausalDAG } from 'foottrace';

import type { QualityEntry } from './QualityRecorder.js';

/** Minimal per-step quality lookup — satisfied by `QualityRecorder` (structural, decoupled). */
export interface QualityLookup {
  getByKey(runtimeStageId: string): QualityEntry | undefined;
}

/** A single frame in the quality stack trace. */
export interface QualityFrame {
  runtimeStageId: string;
  stageName: string;
  score: number;
  factors: string[];
  linkedBy: string;
  depth: number;
}

/** The full quality stack trace. */
export interface QualityStackTrace {
  startId: string;
  startScore: number;
  frames: QualityFrame[];
  rootCause?: {
    frame: QualityFrame;
    previousFrame: QualityFrame;
    drop: number;
  };
}

/**
 * Build a quality stack trace by decorating a causal chain with scores.
 * Root cause is the largest positive score drop across a recorded parent→child
 * dependency with known scores. Ties retain the first edge in BFS node / parent
 * order. This score comparison is a diagnostic hint, not proof of why quality fell.
 *
 * @param commitLog        From executor.getSnapshot().commitLog
 * @param qualityRecorder  QualityRecorder attached during execution
 * @param startId          runtimeStageId to start from
 * @param maxDepth         Maximum backtracking depth (default: 20)
 */
export function qualityTrace(
  commitLog: CommitBundle[],
  qualityRecorder: QualityLookup,
  startId: string,
  maxDepth = 20,
): QualityStackTrace {
  const startEntry = qualityRecorder.getByKey(startId);
  if (!startEntry) {
    return { startId, startScore: -1, frames: [] };
  }

  // Use causalChain to build the DAG, providing keysRead from the QualityRecorder
  const root = causalChain(commitLog, startId, (id) => qualityRecorder.getByKey(id)?.keysRead ?? [], { maxDepth });

  if (!root) {
    return { startId, startScore: startEntry.score, frames: [] };
  }

  // Flatten DAG to BFS-ordered frames, decorate with quality scores
  const nodes = flattenCausalDAG(root);
  const frames: QualityFrame[] = nodes.map((node) => {
    const entry = qualityRecorder.getByKey(node.runtimeStageId);
    return {
      runtimeStageId: node.runtimeStageId,
      stageName: node.stageName,
      score: entry?.score ?? -1,
      factors: entry?.factors ?? [],
      linkedBy: node.linkedBy,
      depth: node.depth,
    };
  });

  // Depth is display metadata, not ancestry: shared parents can be at the same
  // depth as their child. Foottrace owns the edges; compare those exact links.
  const framesById = new Map(frames.map((frame) => [frame.runtimeStageId, frame]));
  let rootCause: QualityStackTrace['rootCause'];
  for (const [i, node] of nodes.entries()) {
    const frame = frames[i];
    if (frame.score < 0) continue;
    for (const parent of node.parents) {
      // flattenCausalDAG includes every reachable parent exactly once.
      const parentFrame = framesById.get(parent.runtimeStageId)!;
      if (parentFrame.score < 0) continue;
      const drop = parentFrame.score - frame.score;
      if (drop > 0 && (!rootCause || drop > rootCause.drop)) {
        rootCause = { frame, previousFrame: parentFrame, drop };
      }
    }
  }

  return {
    startId,
    startScore: startEntry.score,
    frames,
    rootCause,
  };
}

/**
 * Format a QualityStackTrace as human-readable text.
 */
export function formatQualityTrace(trace: QualityStackTrace): string {
  if (trace.frames.length === 0) {
    return `Quality Trace: no data for ${trace.startId}`;
  }

  const lines: string[] = [`Quality Trace (score: ${trace.startScore.toFixed(2)} at ${trace.startId}):`];

  for (const frame of trace.frames) {
    const scoreStr = frame.score >= 0 ? frame.score.toFixed(2) : '?';
    const link = frame.linkedBy ? ` (via ${frame.linkedBy})` : '';
    const factors = frame.factors.length > 0 ? ` — ${frame.factors.join(', ')}` : '';
    lines.push(`  at ${frame.runtimeStageId.padEnd(30)} score=${scoreStr}${link}${factors}`);
  }

  if (trace.rootCause) {
    lines.push('');
    lines.push(
      `Root cause: quality dropped at ${trace.rootCause.frame.runtimeStageId} ` +
        `(${trace.rootCause.previousFrame.score.toFixed(2)} → ${trace.rootCause.frame.score.toFixed(2)}, ` +
        `Δ${trace.rootCause.drop.toFixed(2)})`,
    );
  }

  return lines.join('\n');
}
