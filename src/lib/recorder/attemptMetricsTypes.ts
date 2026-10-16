/** Payload-free P7 rows and public metric projections. Store adapters receive named facts, never errors or keys. */
import type { AttemptId } from 'foottrace';

import type { RetryLoopCall, RetryLoopDecision } from '../attempt/retryLoopTypes.js';
import type {
  AttemptCategory,
  AttemptEffect,
  AttemptKind,
  AttemptNext,
  AttemptOutcome,
  AttemptReason,
} from '../attempt/types.js';

export interface AttemptRef {
  readonly id: AttemptId;
  readonly series: string;
  readonly runId: string;
  readonly runtimeStageId: string;
  readonly attemptKind: AttemptKind;
  readonly retryLoop?: RetryLoopCall;
  readonly target: string;
  readonly traceId?: string;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly outcome: AttemptOutcome;
  readonly category?: AttemptCategory;
  readonly next: AttemptNext;
  readonly reason: AttemptReason;
}
export interface PhysicalAttemptRow extends AttemptRef {
  readonly kind: 'attempt';
  readonly attemptKind: AttemptKind;
  readonly attempt: number;
  readonly of?: number;
  readonly effect?: AttemptEffect;
  readonly retryLoop?: RetryLoopCall;
}
export interface AttemptDecisionRow extends RetryLoopDecision {
  readonly kind: 'decision';
  readonly runId: string;
  readonly target: string;
  readonly runtimeStageId: string;
  readonly attemptId: AttemptId;
  readonly startedAt: number;
}
export interface AttemptRunRow {
  readonly kind: 'run';
  readonly runId: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly outcome: 'running' | 'ok' | 'failed' | 'paused';
}
export type AttemptRow = PhysicalAttemptRow | AttemptDecisionRow | AttemptRunRow;
export interface AttemptQuery {
  readonly since?: number;
  readonly until?: number;
  readonly target?: string;
  readonly runId?: string;
}
export interface AttemptStore {
  append(rows: readonly AttemptRow[]): void | Promise<void>;
  read(query: AttemptQuery): Promise<readonly AttemptRow[]>;
}
export interface AttemptStorageStats {
  readonly pending: number;
  readonly failed: number;
  readonly dropped: number;
  readonly omittedRows: number;
  readonly incomplete: boolean;
}
export interface AttemptStats {
  readonly target: string;
  readonly count: number;
  readonly byKind: Record<AttemptKind, number>;
  readonly byOutcome: Record<AttemptOutcome, number>;
  readonly byCategory: Record<AttemptCategory, number>;
  readonly retries: number;
  readonly seriesRetried: number;
  readonly gaveUp: number;
  readonly effectUnknown: number;
  readonly latencyMs: {
    readonly p50: number;
    readonly p90: number;
    readonly p95: number;
    readonly max: number;
    readonly mean: number;
  };
  /** Sum of attempt durations (work time), which can overlap or nest; not elapsed run time. */
  readonly budgetUsedMs: number;
  readonly exemplars: {
    readonly slowest: AttemptRef[];
    readonly timeout: AttemptRef[];
    readonly failed: AttemptRef[];
    readonly unknown: AttemptRef[];
    readonly gaveUp: AttemptRef[];
  };
}
export interface AttemptRunStats {
  readonly runId: string;
  readonly attempts: number;
  readonly retries: number;
  readonly gaveUp: number;
  readonly budgetUsedMs: number;
  readonly budgetMs?: number;
  readonly outcome: AttemptRunRow['outcome'] | 'incomplete';
}
export interface AttemptAggregate {
  readonly byTarget: Map<string, AttemptStats>;
  readonly byRun: Map<string, AttemptRunStats>;
  readonly storage: AttemptStorageStats;
}
export interface AttemptRecorderOptions {
  readonly exemplars?: number;
  readonly maxRows?: number;
  readonly maxPending?: number;
  readonly storeTimeoutMs?: number;
  readonly store?: AttemptStore;
}
