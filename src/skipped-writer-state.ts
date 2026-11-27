import type { LogAddress, StoredDecision } from 'foottrace';

import type { SkippedChartProjection } from './lib/engine/graph/skippedProjection.js';

export interface SkippedCandidate {
  readonly decision: StoredDecision;
  readonly skippedEntry: string;
  readonly writers: readonly {
    readonly placementId: string;
    readonly stageId: string;
    readonly basis: 'declared' | 'observed';
  }[];
}

interface SkippedEvidence {
  readonly address: LogAddress;
  readonly chart: SkippedChartProjection;
  readonly from: number;
  readonly to: number;
}

/** @internal */
export interface Evaluator {
  readonly evaluateSkippedPaths: (
    entries: readonly unknown[],
    key: string,
    beforeIdx: number,
    options: SkippedEvidence,
  ) => { readonly candidates: readonly SkippedCandidate[]; readonly gaps: readonly string[] };
  readonly savedChartDigest?: (chart: unknown) => Promise<string>;
}

/** @internal */
export interface LiveCapture {
  readonly evidence: SkippedEvidence;
  readonly rows: readonly string[];
  readonly gap: 'truncated' | 'not-collected' | undefined;
}

export const liveCaptures = new WeakMap<object, LiveCapture>();

/** @internal Exact live chart admission for parity tests. */
export function liveSkippedChartOf(snapshot: object): SkippedChartProjection | undefined {
  return liveCaptures.get(snapshot)?.evidence.chart;
}
