/**
 * RFC-001 Block 7 — SECURITY + PROPERTY tests: capture runs strictly AFTER
 * the redaction decision at every dispatch site.
 *
 * The property: plant a redaction policy and a sentinel value; run charts
 * that write / read / commit / emit the sentinel; NO pre-redaction value may
 * appear in ANY envelope payload delivered on ANY channel, under ANY capture
 * policy ('summary' previews, 'clone' copies, and 'ref' live references all
 * see only the post-redaction event object).
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { CapturePolicy } from '../../../../src/index';
import { flowChart, FlowChartExecutor } from '../../../../src/index';

type Loose = Record<string, unknown>;

const SENTINEL = 'SENTINEL-RAW-4242-DO-NOT-LEAK';

function chartWithSecret() {
  return flowChart<Loose>(
    'Seed',
    async (scope) => {
      scope.$setValue('secretKey', SENTINEL); // policy-redacted write
      scope.$setValue('publicKey', 'public-value');
    },
    'seed',
  )
    .addFunction(
      'ReadAndEmit',
      async (scope) => {
        scope.$getValue('secretKey'); // redacted read
        scope.$emit('secret.leak-attempt', { raw: SENTINEL }); // emitPattern-redacted
        scope.$emit('open.event', { ok: true });
      },
      'read-emit',
    )
    .build();
}

async function collectDeferredPayloads(capture: CapturePolicy): Promise<unknown[]> {
  const payloads: unknown[] = [];
  const executor = new FlowChartExecutor(chartWithSecret());
  executor.setRedactionPolicy({ keys: ['secretKey'], emitPatterns: [/^secret\./] });
  executor.attachCombinedRecorder(
    {
      id: 'collector',
      onWrite: (e) => payloads.push(e),
      onRead: (e) => payloads.push(e),
      onCommit: (e) => payloads.push(e),
      onEmit: (e) => payloads.push(e),
      onStageExecuted: (e) => payloads.push(e),
    },
    { delivery: 'deferred', capture },
  );
  await executor.run();
  return payloads;
}

function deepStringify(value: unknown): string {
  // Cycle-tolerant stringify — 'ref' payloads may alias engine structures.
  const seen = new Set<object>();
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return '[circular]';
      seen.add(v);
    }
    return v;
  });
}

describe('Block 7 — capture is post-redaction on every channel (security)', () => {
  for (const capture of ['summary', 'clone', 'ref'] as const) {
    it(`'${capture}' capture: the sentinel never appears in any envelope; [REDACTED] does`, async () => {
      const payloads = await collectDeferredPayloads(capture);
      expect(payloads.length).toBeGreaterThan(0);
      const all = payloads.map(deepStringify).join('\n');
      expect(all).not.toContain(SENTINEL);
      expect(all).toContain('[REDACTED]');
      // The non-secret data still flows (redaction is targeted, not global).
      if (capture !== 'summary') expect(all).toContain('public-value');
    });
  }

  it('property: random secret values never leak through deferred envelopes (fuzzed)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 8, maxLength: 60 }).filter((s) => s.length >= 8 && !s.includes('REDACTED')),
        fc.constantFrom<CapturePolicy>('summary', 'clone'),
        async (secret, capture) => {
          const marker = `FUZZ${secret}FUZZ`; // unique needle, search-safe
          const chart = flowChart<Loose>(
            'Seed',
            async (scope) => {
              scope.$setValue('password', marker);
              scope.$emit('secret.fuzz', { v: marker });
            },
            'seed',
          ).build();
          const payloads: unknown[] = [];
          const executor = new FlowChartExecutor(chart);
          executor.setRedactionPolicy({ keys: ['password'], emitPatterns: [/^secret\./] });
          executor.attachCombinedRecorder(
            {
              id: 'fuzz',
              onWrite: (e) => payloads.push(e),
              onCommit: (e) => payloads.push(e),
              onEmit: (e) => payloads.push(e),
            },
            { delivery: 'deferred', capture },
          );
          await executor.run();
          const all = payloads.map(deepStringify).join('\n');
          return !all.includes(marker);
        },
      ),
      { numRuns: 15 },
    );
  });

  it('per-call redaction (setValue(..., true)) is honored before capture too', async () => {
    const chart = flowChart<Loose>(
      'Seed',
      async (scope) => {
        scope.$setValue('adhoc', SENTINEL, true); // per-call redact flag
      },
      'seed',
    ).build();
    const payloads: unknown[] = [];
    const executor = new FlowChartExecutor(chart);
    executor.attachScopeRecorder(
      { id: 'adhoc-watch', onWrite: (e) => payloads.push(e), onCommit: (e) => payloads.push(e) },
      { delivery: 'deferred', capture: 'clone' },
    );
    await executor.run();
    const all = payloads.map(deepStringify).join('\n');
    expect(all).not.toContain(SENTINEL);
    expect(all).toContain('[REDACTED]');
  });
});
