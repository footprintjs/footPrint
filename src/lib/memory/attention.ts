/** Engine-owned attention is collected with retained facts; snapshots only copy this bounded projection. */
import type { Attention } from 'foottrace';
import { buildAttemptId, parseAttemptId } from 'foottrace';

import type { AttemptRecord, AttemptSummary } from '../attempt/types.js';

const MAX_MARKS = 32;
const MAX_REFERENCES = 16;
const MAX_REFERENCE_LENGTH = 512;
const STOPPED_REASONS = new Set(['exhausted', 'declined', 'no-time-left']);
const MISSING_ATTENTION: Attention = Object.freeze({
  kind: 'not-collected',
  reason: 'EVIDENCE_NOT_COLLECTED',
  evidence: Object.freeze([]),
});

function validReference(reference: unknown): reference is string {
  return (
    typeof reference === 'string' &&
    reference.length > 0 &&
    reference.length <= MAX_REFERENCE_LENGTH &&
    // eslint-disable-next-line no-control-regex -- Match the shared Foottrace evidence-reference boundary.
    !/[\u0000-\u001f\u007f-\u009f]/.test(reference)
  );
}

/** Reuse the one attempt grammar, including nested call addresses; never shorten an unaddressable proof. */
function attemptReference(record: AttemptRecord, owner: string): string | undefined {
  if (
    typeof record.series !== 'string' ||
    !Number.isSafeInteger(record.attempt) ||
    record.attempt < 1 ||
    record.series.length + String(record.attempt).length + 1 > MAX_REFERENCE_LENGTH
  )
    return undefined;
  try {
    const candidate = record.series + '@' + record.attempt;
    const parts = parseAttemptId(candidate);
    if (
      !parts ||
      parts.runtimeStageId !== owner ||
      (record.kind === 'stage' ? parts.call !== undefined : parts.call === undefined)
    )
      return undefined;
    const canonical = buildAttemptId(parts.runtimeStageId, parts.attempt, parts.call);
    return canonical === candidate && validReference(canonical) ? canonical : undefined;
  } catch {
    return undefined;
  }
}

type TerminalProof = Pick<AttemptRecord, 'next' | 'reason' | 'effect'> & { readonly evidence: string };

/** One execution's ownership, pending summary, marks and omission accounting stay in this helper. */
export class StageAttention {
  private marks?: Map<string, Attention>;
  private omitted = false;
  private retryPossible = false;
  private summary?: AttemptSummary;
  private terminal?: TerminalProof;

  /** A new execution starts fresh; an attempt discard never calls this. No collection is reconstructed. */
  begin(): void {
    this.marks = undefined;
    this.omitted = false;
    this.retryPossible = false;
    this.summary = undefined;
    this.terminal = undefined;
  }

  /** Called only after the frame retained this attempt. Raw error, target and decision payloads are never read. */
  recordAttempt(record: AttemptRecord, owner: string): void {
    const reference = attemptReference(record, owner);
    if (record.kind === 'stage' && record.series === owner) {
      if (record.retryLoop === undefined && (record.of ?? 1) > 1) this.retryPossible = true;
      if (reference && record.next !== 'retry') {
        this.terminal = { next: record.next, reason: record.reason, effect: record.effect, evidence: reference };
      }
    }
    // The runner calls recordSummary before its final attempt. Finish that pending projection now too.
    this.projectSummary();
    const add = (kind: Attention['kind'], reason: Attention['reason']) => {
      if (reference) this.append({ kind, reason, evidence: [reference] });
      else this.missing();
    };
    if (record.effect === 'unknown') add('unknown-effect', 'UNKNOWN_EFFECT_RECORDED');
    if (record.outcome === 'timeout') add('timeout', 'TIMEOUT_RECORDED');
    // An SDK's suggested next/reason is not its actual policy; only a later ordinal proves its retry.
    const observed = record.kind === 'observed';
    if ((!observed && record.next === 'retry') || record.attempt > 1) add('retried', 'RETRY_RECORDED');
    if (
      !observed &&
      record.next === 'stop' &&
      STOPPED_REASONS.has(record.reason) &&
      (record.of ?? 1) > 1 &&
      record.retryLoop === undefined
    )
      add('gave-up', 'RETRY_STOP_RECORDED');
  }

  recordSummary(summary: AttemptSummary): void {
    this.summary = summary;
    this.projectSummary();
  }

  /** A summary-only cut wait has no phantom final attempt; use its actual retained summary. */
  private projectSummary(): void {
    const last = this.summary?.last;
    if (!last) return;
    const terminal = this.terminal;
    const matching = terminal?.next === last.next && terminal.reason === last.reason;
    const add = (kind: Attention['kind'], reason: Attention['reason'], proof?: string) => {
      const reference = proof ?? 'attemptSummary';
      const key = kind + ':' + reason;
      const marks = this.marks;
      const previous = marks?.get(key);
      if (proof && marks && previous?.evidence.includes('attemptSummary')) {
        marks.set(key, { ...previous, evidence: previous.evidence.filter((item) => item !== 'attemptSummary') });
      }
      this.append({ kind, reason, evidence: [reference] });
    };
    if (last.effect === 'unknown')
      add(
        'unknown-effect',
        'UNKNOWN_EFFECT_RECORDED',
        matching && terminal.effect === 'unknown' ? terminal.evidence : undefined,
      );
    if (this.retryPossible && last.next === 'stop' && STOPPED_REASONS.has(last.reason))
      add('gave-up', 'RETRY_STOP_RECORDED', matching ? terminal.evidence : undefined);
  }

  /** Only the explicit retained stage-error path calls this; a diagnostic value never classifies itself. */
  stageFailed(errors: unknown): void {
    try {
      const descriptor =
        errors && typeof errors === 'object'
          ? Object.getOwnPropertyDescriptor(errors, 'stageExecutionError')
          : undefined;
      if (descriptor && Object.hasOwn(descriptor, 'value')) {
        this.append({ kind: 'error', reason: 'ERROR_RECORDED', evidence: ['errors:stageExecutionError'] });
        return;
      }
    } catch {
      /* A malformed evidence bag is unavailable, never another stage failure. */
    }
    this.missing();
  }

  attemptDropped(): void {
    this.append({ kind: 'not-collected', reason: 'EVIDENCE_NOT_COLLECTED', evidence: ['attemptsDropped'] });
  }

  /** Keep only bounded exact references; one slot is reserved to disclose omissions. */
  append(attention: Attention): void {
    const key = attention.kind + ':' + attention.reason;
    const previous = this.marks?.get(key);
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
    if (!previous && (this.marks?.size ?? 0) >= MAX_MARKS - 1) {
      this.omitted = true;
      return;
    }
    (this.marks ??= new Map()).set(key, { kind: attention.kind, reason: attention.reason, evidence: references });
  }

  missing(): void {
    this.omitted = true;
  }

  /** Copy already collected bounded marks, never an attempt array, diagnostic bag or execution tree. */
  snapshot(): readonly Attention[] {
    const result = [...(this.marks?.values() ?? [])].map((attention) =>
      Object.freeze({ ...attention, evidence: Object.freeze([...attention.evidence]) }),
    );
    if (this.omitted && !result.some((attention) => attention.kind === 'not-collected')) result.push(MISSING_ATTENTION);
    return Object.freeze(result);
  }
}
