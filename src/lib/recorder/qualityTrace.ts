/**
 * qualityTrace() — Quality Stack Trace built on causalChain().
 *
 * Thin layer over `memory/backtrack.causalChain()` that decorates
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

import { causalChain, flattenCausalDAG } from '../memory/backtrack.js';
import type { CommitBundle } from '../memory/types.js';
import type { KeyedRecorder } from './KeyedRecorder.js';
import type { QualityEntry } from './QualityRecorder.js';

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
 *
 * @param commitLog        From executor.getSnapshot().commitLog
 * @param qualityRecorder  QualityRecorder attached during execution
 * @param startId          runtimeStageId to start from
 * @param maxDepth         Maximum backtracking depth (default: 20)
 */
export function qualityTrace(
  commitLog: CommitBundle[],
  qualityRecorder: KeyedRecorder<QualityEntry>,
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

  // Find root cause: biggest quality drop between adjacent frames (BFS order)
  let rootCause: QualityStackTrace['rootCause'];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    // Look at each parent (frames at depth + 1)
    for (const parentFrame of frames.filter((f) => f.depth === frame.depth + 1)) {
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
