/**
 * Skipped writers. Query evidence on an exact live FootPrint capture.
 *
 * @module footprintjs/skipped-writers
 */
import { captureWitnessOf } from './lib/capture/explainWitness.js';
import type { StageNode } from './lib/engine/graph/StageNode.js';
import type { FlowChartExecutorOptions } from './lib/runner/options.js';
import { type Evaluator, type SkippedCandidate, liveCaptures } from './skipped-writer-state.js';

export interface NativeSkippedWritersResult {
  readonly candidates: readonly (SkippedCandidate & { readonly binding: 'native' })[];
  readonly gaps: readonly string[];
}

let optionalEvaluator: Promise<Evaluator | undefined> | undefined;

function evaluator(): Promise<Evaluator | undefined> {
  return (optionalEvaluator ??= import('foottrace/cause')
    .then((reader) => {
      const capability = reader as Partial<Evaluator>;
      const { evaluateSkippedPaths, savedChartDigest } = capability;
      if (typeof evaluateSkippedPaths !== 'function') return undefined;
      return {
        evaluateSkippedPaths,
        savedChartDigest: typeof savedChartDigest === 'function' ? savedChartDigest : undefined,
      };
    })
    .catch(() => undefined));
}

const declarations = new WeakMap<object, readonly string[]>();

function unavailable(gap: string): NativeSkippedWritersResult {
  return { candidates: [], gaps: [gap] };
}

/** Only an exact served snapshot can supply the native chart and retained writer entries. */
export async function readSkippedWriters(
  snapshot: object,
  key: string,
  beforeIdx: number,
): Promise<NativeSkippedWritersResult> {
  const capability = await evaluator();
  if (!capability) return unavailable('not-collected');
  const capture = liveCaptures.get(snapshot);
  if (!capture) {
    const witness = captureWitnessOf(snapshot);
    return unavailable(
      witness?.boundary === 'completed' && witness.commits.from > 0 ? 'not-collected' : 'chart-binding',
    );
  }
  if (capture.gap) return unavailable(capture.gap);
  const result = capability.evaluateSkippedPaths(
    capture.rows.map((row) => JSON.parse(row)),
    key,
    beforeIdx,
    capture.evidence,
  );
  return {
    candidates: result.candidates.map((candidate) => ({ ...candidate, binding: 'native' })),
    gaps: result.gaps,
  };
}

/** Declare the exhaustive write paths for an exact authored stage placement. */
export function declareSkippedWriterPaths(placement: StageNode, paths: readonly string[]): void {
  declarations.set(placement, Object.freeze([...paths]));
}

/**
 * Enable bounded skipped-writer capture when the installed Foottrace supplies the evaluator.
 * Use the returned options with a same-instance executor configured with a record sink.
 */
export async function skippedWriterCaptureOptions<TScope>(
  options: FlowChartExecutorOptions<TScope> = {},
): Promise<FlowChartExecutorOptions<TScope>> {
  const capability = await evaluator();
  if (!capability) return options;
  const { configureSkippedWriterCapture } = await import('./skipped-writer-capture.js');
  return configureSkippedWriterCapture(
    options,
    capability,
    (placement) => declarations.get(placement),
    (snapshot, capture) => liveCaptures.set(snapshot, capture),
  );
}
