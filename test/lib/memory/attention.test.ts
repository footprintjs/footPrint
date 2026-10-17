/**
 * C2 attention is collected synchronously with retained evidence, never rediscovered by a snapshot walk.
 * Unit/functional: fixed marks and proof locators. Boundary: summary ordering, missing proof and caps.
 * Security: no payload text/getter traversal. Property/metamorphic: equivalent evidence yields equivalent marks.
 * Real engine/scenario coverage is in attention-engine.test.ts; the root owns original flow byte guards.
 */
import fc from 'fast-check';
import type { Attention } from 'foottrace';
import { buildAttemptId, parseAttemptId } from 'foottrace';
import { EventLog, SharedMemory } from 'foottrace/write';
import { describe, expect, it, vi } from 'vitest';

import type { AttemptRecord, AttemptSummary } from '../../../src/index.js';
import { StageContext } from '../../../src/lib/memory/StageContext.js';

function context() {
  const log = new EventLog({});
  const ctx = new StageContext('attention-run', 'Check', 'check', new SharedMemory(), '', log);
  ctx.runtimeStageId = 'check#0';
  return { ctx, log };
}
function record(fields: Partial<AttemptRecord> = {}): AttemptRecord {
  const next = fields.next ?? 'done';
  return {
    series: 'check#0',
    kind: 'stage',
    attempt: 1,
    of: 1,
    startedAt: 100,
    durationMs: 2,
    outcome: 'ok',
    decision: { rules: [], chosen: next, default: 'retry' },
    next,
    reason: 'succeeded',
    ...fields,
  };
}
function summary(fields: Partial<AttemptSummary> = {}): AttemptSummary {
  return {
    count: 1,
    ok: 1,
    failed: 0,
    timeout: 0,
    aborted: 0,
    paused: 0,
    last: { next: 'done', reason: 'succeeded' },
    ...fields,
  };
}
function marks(ctx: StageContext): readonly Attention[] | undefined {
  return (ctx.getSnapshot() as { attention?: readonly Attention[] }).attention;
}
function kinds(ctx: StageContext) {
  return (marks(ctx) ?? []).map((mark) => mark.kind);
}
function proof(ctx: StageContext, kind: Attention['kind']) {
  return (marks(ctx) ?? []).find((mark) => mark.kind === kind)?.evidence;
}
function canonicalAttempt(record: AttemptRecord): string {
  if (record.kind === 'stage') return buildAttemptId(record.series, record.attempt);
  const parsed = parseAttemptId(record.series + '@' + record.attempt);
  if (!parsed?.call) throw new Error('TEST_INVALID_CALL_ID');
  return buildAttemptId(parsed.runtimeStageId, parsed.attempt, parsed.call);
}
function expectRetainedProof(ctx: StageContext, reference: string) {
  expect(reference.startsWith('attempts:')).toBe(false);
  const parsed = parseAttemptId(reference);
  if (parsed) {
    expect(reference).toBe(buildAttemptId(parsed.runtimeStageId, parsed.attempt, parsed.call));
    expect(ctx.attempts?.some((entry) => canonicalAttempt(entry) === reference)).toBe(true);
  } else expect(['attemptSummary', 'attemptsDropped', 'errors:stageExecutionError']).toContain(reference);
}

describe('C2 synchronous stage attention', () => {
  it('keeps healthy no-policy and first-try policy snapshots byte-shape unchanged', () => {
    const { ctx } = context();
    expect(Object.hasOwn(ctx.getSnapshot(), 'attention')).toBe(false);
    ctx.endAttempts(summary());
    ctx.recordAttempt(record());
    expect(Object.hasOwn(ctx.getSnapshot(), 'attention')).toBe(false);
  });

  it('flags a recorded retry immediately, before the series ends or the stage commits', () => {
    const { ctx, log } = context();
    ctx.recordAttempt(record({ outcome: 'failed', next: 'retry', reason: 'retryable', of: 2 }));
    expect(kinds(ctx)).toContain('retried');
    expect(proof(ctx, 'retried')).toContain(buildAttemptId('check#0', 1));
    expect(log.list()).toEqual([]);
    ctx.endAttempts(summary({ count: 2, failed: 1 }));
    ctx.recordAttempt(record({ attempt: 2, of: 2 }));
    expect(kinds(ctx)).not.toContain('gave-up');
    expect(kinds(ctx)).not.toContain('outlier');
  });

  it('keeps timeout and unknown effect as separate facts with kept attempt proof', () => {
    const { ctx } = context();
    ctx.reportCallAttempt(
      record({
        kind: 'call',
        series: 'check#0@1.1',
        target: 'payments',
        outcome: 'timeout',
        effect: 'unknown',
        next: 'stop',
        reason: 'exhausted',
      }),
      undefined,
    );
    expect(kinds(ctx)).toEqual(expect.arrayContaining(['timeout', 'unknown-effect']));
    expect(proof(ctx, 'timeout')).toContain(buildAttemptId('check#0', 1, { ordinal: 1, attempt: 1 }));
    expect(proof(ctx, 'unknown-effect')).toContain(buildAttemptId('check#0', 1, { ordinal: 1, attempt: 1 }));
    expect((marks(ctx) ?? []).find((mark) => mark.kind === 'timeout')?.reason).toBe('TIMEOUT_RECORDED');
    expect((marks(ctx) ?? []).find((mark) => mark.kind === 'unknown-effect')?.reason).toBe('UNKNOWN_EFFECT_RECORDED');
  });

  it('uses summary-before-final-record ordering without losing a final exhausted mark', () => {
    const { ctx } = context();
    ctx.recordAttempt(record({ outcome: 'failed', next: 'retry', reason: 'retryable', of: 2 }));
    ctx.endAttempts(summary({ count: 2, ok: 0, failed: 2, last: { next: 'stop', reason: 'exhausted' } }));
    ctx.recordAttempt(record({ attempt: 2, of: 2, outcome: 'failed', next: 'stop', reason: 'exhausted' }));
    expect(kinds(ctx)).toContain('gave-up');
    expect(proof(ctx, 'gave-up')).toEqual([buildAttemptId('check#0', 2)]);
  });

  it('keeps a cut-backoff summary without inventing a timeout, new attempt or retry exhaustion', () => {
    const { ctx } = context();
    ctx.recordAttempt(record({ outcome: 'failed', next: 'retry', reason: 'retryable', of: 4 }));
    ctx.endAttempts(summary({ ok: 0, failed: 1, last: { next: 'stop', reason: 'aborted' } }));
    expect(kinds(ctx)).toContain('retried');
    expect(kinds(ctx)).not.toContain('gave-up');
    expect(kinds(ctx)).not.toContain('timeout');
    expect(ctx.attempts).toHaveLength(1);
  });

  it('does not flag a pause as a failure or gave-up operation', () => {
    const { ctx } = context();
    ctx.endAttempts(summary({ ok: 0, paused: 1, last: { next: 'stop', reason: 'paused' } }));
    ctx.recordAttempt(record({ outcome: 'paused', next: 'stop', reason: 'paused' }));
    expect(marks(ctx)).toBeUndefined();
  });

  it('does not label a physical single call as the logical retry workflow giving up', () => {
    const { ctx } = context();
    ctx.reportCallAttempt(
      record({
        kind: 'call',
        target: 'payments',
        series: 'check#0@1.1',
        outcome: 'failed',
        next: 'stop',
        reason: 'exhausted',
        retryLoop: { id: 'pay', series: 'pay-loop', attempt: 1, of: 4, phase: 'attempt' },
      }),
      undefined,
    );
    expect(kinds(ctx)).not.toContain('gave-up');
  });

  it('discloses dropped call evidence and never points a factual mark at an unretained attempt', () => {
    const { ctx } = context();
    for (let i = 0; i < 1000; i++)
      ctx.reportCallAttempt(record({ kind: 'call', series: `check#0@1.${i + 1}`, target: 'lookup' }), undefined);
    ctx.reportCallAttempt(
      record({
        kind: 'call',
        series: 'check#0@1.1001',
        target: 'lookup',
        outcome: 'timeout',
        next: 'stop',
        reason: 'exhausted',
      }),
      undefined,
    );
    expect(ctx.getSnapshot().attemptsDropped).toBe(1);
    expect(kinds(ctx)).toContain('not-collected');
    expect(proof(ctx, 'not-collected')).toContain('attemptsDropped');
    expect(kinds(ctx)).not.toContain('timeout');
    expect(JSON.stringify(marks(ctx))).not.toContain(buildAttemptId('check#0', 1, { ordinal: 1001, attempt: 1 }));
  });

  it('uses the real retained stage failure field and clears the marks at a new execution boundary', () => {
    const { ctx } = context();
    ctx.addDiagnostic('errors', 'stageExecutionError', 'PRIVATE_ERROR_TEXT');
    ctx.markStageFailure();
    expect(marks(ctx)).toEqual([{ kind: 'error', reason: 'ERROR_RECORDED', evidence: ['errors:stageExecutionError'] }]);
    ctx.beginAttention();
    expect(marks(ctx)).toBeUndefined();
  });

  it('uses the shared codec for stage and nested call identities with legal punctuation', () => {
    for (const kind of ['stage', 'call', 'observed'] as const) {
      const { ctx } = context();
      ctx.runtimeStageId = 'sf/v1.2@x#7';
      const entry = record({
        kind,
        series: kind === 'stage' ? ctx.runtimeStageId : ctx.runtimeStageId + '@2.3',
        attempt: 4,
        of: 5,
        outcome: 'timeout',
        next: 'stop',
        reason: 'exhausted',
      });
      if (kind === 'stage') ctx.recordAttempt(entry);
      else ctx.reportCallAttempt(entry, undefined);
      expect(proof(ctx, 'timeout')).toEqual([canonicalAttempt(entry)]);
      for (const reference of proof(ctx, 'timeout') ?? []) expectRetainedProof(ctx, reference);
    }
  });

  it('does not turn malformed or foreign attempt identity into factual proof', () => {
    for (const series of ['not-an-execution', 'foreign#9', 'check#0@01.1']) {
      const { ctx } = context();
      ctx.reportCallAttempt(
        record({ kind: 'call', series, outcome: 'timeout', next: 'stop', reason: 'exhausted' }),
        undefined,
      );
      expect(kinds(ctx)).toContain('not-collected');
      expect(kinds(ctx)).not.toContain('timeout');
    }
  });

  it('omits oversized canonical attempt proof without manufacturing a truncated identity', () => {
    const { ctx } = context();
    ctx.runtimeStageId = 'PRIVATE_OVERSIZED_' + 'x'.repeat(600) + '#0';
    ctx.recordAttempt(record({ series: ctx.runtimeStageId, outcome: 'timeout', next: 'stop', reason: 'exhausted' }));
    expect(kinds(ctx)).toContain('not-collected');
    expect(kinds(ctx)).not.toContain('timeout');
    expect(JSON.stringify(marks(ctx))).not.toContain('PRIVATE_OVERSIZED_');
  });

  it('does not inspect raw error, decision or unknown extra fields while recording fixed attention', () => {
    const { ctx } = context();
    const get = vi.fn(() => {
      throw new Error('PRIVATE_GETTER');
    });
    const item = record({ outcome: 'timeout', effect: 'unknown', next: 'stop', reason: 'exhausted' });
    Object.defineProperty(item, 'error', { get });
    Object.defineProperty(item, 'decision', { get });
    Object.defineProperty(item, 'raw', { get });
    ctx.recordAttempt(item);
    expect(kinds(ctx)).toEqual(expect.arrayContaining(['timeout', 'unknown-effect']));
    expect(get).not.toHaveBeenCalled();
    expect(JSON.stringify(marks(ctx))).not.toContain('PRIVATE_GETTER');
  });

  it('does no new attempt-field reads when snapshots are requested after collection', () => {
    const { ctx } = context();
    const outcome = vi.fn(() => 'failed' as const);
    const item = record({ next: 'retry', reason: 'retryable', of: 3 });
    Object.defineProperty(item, 'outcome', { get: outcome });
    ctx.recordAttempt(item);
    expect(kinds(ctx)).toContain('retried');
    const atCollection = outcome.mock.calls.length;
    expect(atCollection).toBeGreaterThan(0);
    for (let i = 0; i < 50; i++) expect(kinds(ctx)).toContain('retried');
    expect(outcome).toHaveBeenCalledTimes(atCollection);
  });

  it('bounds retained marks and proof references under thousands of repeated call failures', () => {
    const { ctx } = context();
    for (let i = 0; i < 5000; i++) {
      ctx.reportCallAttempt(
        record({
          kind: 'call',
          series: `check#0@1.${i + 1}`,
          target: 'lookup',
          outcome: 'failed',
          next: 'retry',
          reason: 'retryable',
          of: 2,
        }),
        undefined,
      );
    }
    const snapshot = ctx.getSnapshot();
    expect(snapshot.attempts).toHaveLength(1000);
    expect(snapshot.attemptsDropped).toBe(4000);
    expect(kinds(ctx)).toEqual(expect.arrayContaining(['retried', 'not-collected']));
    expect(marks(ctx)!.length).toBeLessThanOrEqual(32);
    for (const mark of marks(ctx)!) {
      expect(mark.evidence.length).toBeLessThanOrEqual(16);
      expect(new Set(mark.evidence).size).toBe(mark.evidence.length);
      for (const reference of mark.evidence) {
        expect(reference.length).toBeLessThanOrEqual(512);
        expectRetainedProof(ctx, reference);
      }
    }
    expect(JSON.stringify(marks(ctx)).length).toBeLessThan(10000);
  });

  it('keeps marks unchanged when only timing, payload text, target or operation keys change', () => {
    const a = context().ctx;
    const b = context().ctx;
    const fact = { outcome: 'timeout', effect: 'unknown', next: 'stop', reason: 'exhausted', of: 2 } as const;
    a.recordAttempt(
      record({
        ...fact,
        startedAt: 1,
        durationMs: 1,
        error: { message: 'PRIVATE_A' },
        idempotencyKey: 'PRIVATE_KEY_A',
      }),
    );
    b.recordAttempt(
      record({
        ...fact,
        startedAt: 9999,
        durationMs: 77,
        error: { message: 'PRIVATE_B' },
        idempotencyKey: 'PRIVATE_KEY_B',
      }),
    );
    expect(kinds(a)).toContain('timeout');
    expect(marks(a)).toEqual(marks(b));
    expect(JSON.stringify(marks(a) ?? [])).not.toContain('PRIVATE_');
  });

  it('retains only resolvable bounded fixed-word evidence for generated sequences', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('ok', 'failed', 'timeout', 'paused'), { maxLength: 80 }), (outcomes) => {
        const { ctx } = context();
        for (const [i, outcome] of outcomes.entries()) {
          ctx.reportCallAttempt(
            record({
              kind: 'call',
              series: `check#0@1.${i + 1}`,
              target: 'test',
              outcome,
              next: outcome === 'ok' ? 'done' : 'stop',
              reason: outcome === 'ok' ? 'succeeded' : outcome === 'paused' ? 'paused' : 'exhausted',
              of: 2,
              error: { message: 'PRIVATE_GENERATED' },
            }),
            undefined,
          );
        }
        for (const mark of marks(ctx) ?? []) {
          expect([
            'ERROR_RECORDED',
            'UNKNOWN_EFFECT_RECORDED',
            'RETRY_STOP_RECORDED',
            'TIMEOUT_RECORDED',
            'RETRY_RECORDED',
            'QUALITY_DROP_RECORDED',
            'EVIDENCE_NOT_COLLECTED',
          ]).toContain(mark.reason);
          expect(mark.evidence.length).toBeLessThanOrEqual(16);
          for (const reference of mark.evidence) expectRetainedProof(ctx, reference);
        }
        expect(kinds(ctx)).not.toContain('outlier');
        expect(JSON.stringify(marks(ctx) ?? [])).not.toContain('PRIVATE_');
      }),
      { numRuns: 60, seed: 21017 },
    );
  });
});
