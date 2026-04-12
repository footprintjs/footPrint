/**
 * qualityTrace() — backtrack through the commit log to build a Quality Stack Trace.
 *
 * Like an error stack trace but for data quality:
 * ```
 * Quality Trace (score: 0.3 at call-llm#5):
 *   at call-llm#5     score=0.3  ← quality dropped here
 *   at system-prompt#1 score=0.8  ← systemPrompt was good
 *   at seed#0          score=1.0  ← input was clean
 *
 * Root cause: quality dropped at call-llm#5 (0.8 → 0.3)
 * ```
 *
 * Uses findLastWriter() to walk backwards through the causal chain:
 * each hop finds who wrote the keys that the low-scoring stage read.
 */

import { findLastWriter } from '../memory/commitLogUtils.js';
import type { CommitBundle } from '../memory/types.js';
import type { KeyedRecorder } from './KeyedRecorder.js';
import type { QualityEntry } from './QualityRecorder.js';

/** A single frame in the quality stack trace. */
export interface QualityFrame {
  /** The runtimeStageId of this frame. */
  runtimeStageId: string;
  /** Stage name for display. */
  stageName: string;
  /** Quality score at this step. */
  score: number;
  /** Factors explaining the score. */
  factors: string[];
  /** The key that linked this frame to the next (the "read" that caused the hop). */
  linkedBy?: string;
}

/** The full quality stack trace. */
export interface QualityStackTrace {
  /** The starting step (lowest quality). */
  startId: string;
  /** Score at the starting step. */
  startScore: number;
  /** Ordered frames from the starting step back to the root cause. */
  frames: QualityFrame[];
  /** Where the biggest quality drop occurred. */
  rootCause?: {
    /** Frame where quality dropped the most. */
    frame: QualityFrame;
    /** Previous frame (higher quality). */
    previousFrame: QualityFrame;
    /** Size of the drop (previous.score - frame.score). */
    drop: number;
  };
}

/**
 * Walk backwards from a runtimeStageId through the commit log,
 * reading quality scores from the QualityRecorder at each hop.
 *
 * @param commitLog - The commit log from executor.getSnapshot().commitLog
 * @param qualityRecorder - A QualityRecorder that was attached during execution
 * @param startId - The runtimeStageId to start backtracking from
 * @param maxHops - Maximum number of hops (default: 20, prevents infinite loops)
 */
export function qualityTrace(
  commitLog: CommitBundle[],
  qualityRecorder: KeyedRecorder<QualityEntry>,
  startId: string,
  maxHops = 20,
): QualityStackTrace {
  const startEntry = qualityRecorder.getByKey(startId);
  if (!startEntry) {
    return { startId, startScore: -1, frames: [] };
  }

  const frames: QualityFrame[] = [
    {
      runtimeStageId: startId,
      stageName: startEntry.stageName,
      score: startEntry.score,
      factors: startEntry.factors,
    },
  ];

  const visited = new Set<string>([startId]);

  // Find the commit index for the start step
  const startCommitIdx = commitLog.findIndex((b) => b.runtimeStageId === startId);
  if (startCommitIdx < 0) {
    return { startId, startScore: startEntry.score, frames };
  }

  // Walk backwards: for each key the start step READ, find who WROTE it
  let currentEntry = startEntry;
  let currentIdx = startCommitIdx;

  for (let hop = 0; hop < maxHops; hop++) {
    if (currentEntry.keysRead.length === 0) break;

    // Find the most recent writer of any key this step read
    let bestWriter: CommitBundle | undefined;
    let bestKey: string | undefined;

    for (const key of currentEntry.keysRead) {
      const writer = findLastWriter(commitLog, key, currentIdx);
      if (writer && !visited.has(writer.runtimeStageId)) {
        // Prefer the writer closest to currentIdx (most recent)
        if (!bestWriter || (writer.idx !== undefined && bestWriter.idx !== undefined && writer.idx > bestWriter.idx)) {
          bestWriter = writer;
          bestKey = key;
        }
      }
    }

    if (!bestWriter || !bestKey) break;

    visited.add(bestWriter.runtimeStageId);

    const writerEntry = qualityRecorder.getByKey(bestWriter.runtimeStageId);
    const frame: QualityFrame = {
      runtimeStageId: bestWriter.runtimeStageId,
      stageName: bestWriter.stage,
      score: writerEntry?.score ?? -1,
      factors: writerEntry?.factors ?? [],
      linkedBy: bestKey,
    };
    frames.push(frame);

    // Continue backtracking from this writer
    if (!writerEntry) break;
    currentEntry = writerEntry;
    currentIdx = bestWriter.idx ?? currentIdx;
  }

  // Find root cause: biggest quality drop between adjacent frames
  let rootCause: QualityStackTrace['rootCause'];
  for (let i = 0; i < frames.length - 1; i++) {
    const current = frames[i];
    const previous = frames[i + 1];
    if (previous.score < 0) continue; // skip unknown scores
    const drop = previous.score - current.score;
    if (drop > 0 && (!rootCause || drop > rootCause.drop)) {
      rootCause = { frame: current, previousFrame: previous, drop };
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
 * Similar to error stack traces but for quality.
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
