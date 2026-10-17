/**
 * Attention is a bounded projection of facts retained while an execution runs.
 * Proof locators resolve inside the owning StageSnapshot, never against another node or arbitrary state.
 */
import type { Attention } from 'foottrace';

import type { AttemptRecord, AttemptSummary } from '../attempt/types.js';

const MAX_MARKS = 32;
const MAX_REFERENCES = 16;
const MAX_REFERENCE_LENGTH = 512;
const STOPPED_REASONS = new Set(['exhausted', 'declined', 'no-time-left']);
const NO_ATTENTION: readonly Attention[] = Object.freeze([]);
const MISSING_ATTENTION: Attention = Object.freeze({
  kind: 'not-collected',
  reason: 'EVIDENCE_NOT_COLLECTED',
  evidence: Object.freeze([]),
});

/** Fixed reasons describe the recorded fact; they never inspect an error, target, key or decision payload. */
function mark(kind: Attention['kind'], reason: Attention['reason'], evidence: string): Attention {
  return { kind, reason, evidence: [evidence] };
}

/** A decision is projected, not evaluated again; a logical workflow is not exhausted by its physical call. */
export function attentionOfAttempt(record: AttemptRecord, keptIndex: number): readonly Attention[] {
  const evidence = 'attempts:' + keptIndex;
  let marks: Attention[] | undefined;
  const add = (value: Attention) => (marks ??= []).push(value);
  if (record.effect === 'unknown') add(mark('unknown-effect', 'UNKNOWN_EFFECT_RECORDED', evidence));
  if (record.outcome === 'timeout') add(mark('timeout', 'TIMEOUT_RECORDED', evidence));
  // Observed next/reason describe the default table, not the SDK's policy; only its actual ordinal proves a retry.
  const observed = record.kind === 'observed';
  if ((!observed && record.next === 'retry') || record.attempt > 1) add(mark('retried', 'RETRY_RECORDED', evidence));
  if (
    !observed &&
    record.next === 'stop' &&
    STOPPED_REASONS.has(record.reason) &&
    (record.of ?? 1) > 1 &&
    record.retryLoop === undefined
  )
    add(mark('gave-up', 'RETRY_STOP_RECORDED', evidence));
  return marks ?? NO_ATTENTION;
}

/** A cut wait may end a series without another attempt; its real summary is the proof, not a phantom attempt. */
export function attentionOfSummary(summary: AttemptSummary, retryWasPossible: boolean): readonly Attention[] {
  let marks: Attention[] | undefined;
  if (summary.last.effect === 'unknown')
    (marks ??= []).push(mark('unknown-effect', 'UNKNOWN_EFFECT_RECORDED', 'attemptSummary'));
  if (retryWasPossible && summary.last.next === 'stop' && STOPPED_REASONS.has(summary.last.reason))
    (marks ??= []).push(mark('gave-up', 'RETRY_STOP_RECORDED', 'attemptSummary'));
  return marks ?? NO_ATTENTION;
}

/** Producers use only fixed kinds; even an erroneous proof must not make diagnostic storage unbounded. */
function validReference(reference: unknown): reference is string {
  return (
    typeof reference === 'string' &&
    reference.length > 0 &&
    reference.length <= MAX_REFERENCE_LENGTH &&
    // eslint-disable-next-line no-control-regex -- Proof IDs must reject C0/C1 controls, matching Foottrace admission.
    !/[\u0000-\u001f\u007f-\u009f]/.test(reference)
  );
}

/** Aggregate proof references by mark while keeping omissions visible and snapshots detached from later facts. */
export class StageAttention {
  private readonly marks = new Map<string, Attention>();
  private omitted = false;

  /** Keep only bounded exact references; truncating an ID would manufacture a different proof. */
  append(attention: Attention): void {
    const key = attention.kind + ':' + attention.reason;
    const previous = this.marks.get(key);
    const references = [...(previous?.evidence ?? [])];
    for (const reference of attention.evidence) {
      if (!validReference(reference)) {
        this.omitted = true;
        continue;
      }
      if (references.includes(reference)) continue;
      if (references.length >= MAX_REFERENCES) {
        this.omitted = true;
        continue;
      }
      references.push(reference);
    }
    if (attention.kind !== 'not-collected' && references.length === 0) {
      this.omitted = true;
      return;
    }
    // One slot is always available to disclose omissions instead of silently presenting complete coverage.
    if (!previous && this.marks.size >= MAX_MARKS - 1) {
      this.omitted = true;
      return;
    }
    this.marks.set(key, { kind: attention.kind, reason: attention.reason, evidence: references });
  }

  /** Missing proof is itself known; it must not become an unsupported factual attention mark. */
  missing(): void {
    this.omitted = true;
  }

  /** Only the small collected projection is copied here; no attempt, diagnostic or execution tree is revisited. */
  snapshot(): readonly Attention[] {
    const result = [...this.marks.values()].map((attention) =>
      Object.freeze({ ...attention, evidence: Object.freeze([...attention.evidence]) }),
    );
    if (this.omitted && !result.some((attention) => attention.kind === 'not-collected')) result.push(MISSING_ATTENTION);
    return Object.freeze(result);
  }
}

/** Stage failure is retained separately from an attempt's outcome, so commit errors cannot disappear. */
export function stageFailureAttention(): Attention {
  return mark('error', 'ERROR_RECORDED', 'errors:stageExecutionError');
}

/** A quality producer supplies an already retained row's locator; a score alone is not a drop. */
export function qualityDropAttention(evidenceId: string): Attention {
  return mark('quality-drop', 'QUALITY_DROP_RECORDED', evidenceId);
}

/** A dropped attempt has a count, not a retained row at the next array index. */
export function droppedAttemptsAttention(): Attention {
  return mark('not-collected', 'EVIDENCE_NOT_COLLECTED', 'attemptsDropped');
}
