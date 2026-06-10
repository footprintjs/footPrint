/**
 * mergedQueue.test.ts — RFC-001 Block 3 acceptance (seq stamping + channel merge).
 *
 * Convention 3 sections: unit / functional / property / security / load.
 * Acceptance (RFC table):
 *   - randomized interleavings across 3 channels drain in push order (≥100 trials)
 *   - seq monotonic, assigned at capture, gap-detectable after drops
 *   - 'block' refusal surfaces as outcome 'inline' (event NOT lost)
 */

import fc from 'fast-check';

import { type CaptureChannel, type PayloadSummary } from '../../../src/lib/capture/envelope';
import { type EnqueueInput, DEFAULT_MAX_QUEUE, MergedQueue } from '../../../src/lib/observer-queue/mergedQueue';

const CHANNELS: CaptureChannel[] = ['scope', 'flow', 'emit'];

function input(channel: CaptureChannel = 'scope', payload: unknown = { v: 1 }): EnqueueInput {
  return { channel, method: 'onWrite', runtimeStageId: 'seed#0', runId: 'run-1', payload };
}

describe('MergedQueue — unit', () => {
  it('stamps seq monotonically from 0 across channels', () => {
    const q = new MergedQueue();
    const seqs = CHANNELS.map((c) => q.enqueue(input(c)).envelope.seq);
    expect(seqs).toEqual([0, 1, 2]);
    expect(q.nextSeq).toBe(3);
    expect(q.depth).toBe(3);
  });

  it('defaults: capacity 10_000, summary capture policy', () => {
    const q = new MergedQueue();
    expect(q.capacity).toBe(DEFAULT_MAX_QUEUE);
    const { envelope } = q.enqueue(input());
    expect((envelope.payload as PayloadSummary).__payloadSummary).toBe(true);
  });

  it('seq is assigned BEFORE admission — dropped events still consume a stamp', () => {
    const q = new MergedQueue({ maxQueue: 1, overflow: 'drop-oldest' });
    const a = q.enqueue(input());
    const b = q.enqueue(input());
    const c = q.enqueue(input());
    expect([a.envelope.seq, b.envelope.seq, c.envelope.seq]).toEqual([0, 1, 2]);
    expect([a.outcome, b.outcome, c.outcome]).toEqual(['queued', 'queued', 'queued']);
    // Only the newest survived; the two evictions are counted losses.
    expect(q.depth).toBe(1);
    expect(q.shift()?.seq).toBe(2);
    expect(q.getCounters().drops).toBe(2);
  });

  it("'block' overflow: outcome 'inline', envelope stamped, nothing lost", () => {
    const q = new MergedQueue({ maxQueue: 1, overflow: 'block' });
    expect(q.enqueue(input()).outcome).toBe('queued');
    const refused = q.enqueue(input());
    expect(refused.outcome).toBe('inline');
    expect(refused.envelope.seq).toBe(1);
    const c = q.getCounters();
    expect(c.drops).toBe(0);
    expect(c.rejections).toBe(1);
    expect(q.depth).toBe(1); // backlog untouched
  });

  it("'sample' overflow: sampled-out events report outcome 'dropped'", () => {
    const q = new MergedQueue({ maxQueue: 1, overflow: 'sample', sampleEvery: 2 });
    q.enqueue(input());
    expect(q.enqueue(input()).outcome).toBe('dropped'); // saturated arrival 1
    expect(q.enqueue(input()).outcome).toBe('queued'); // arrival 2 — admitted
    expect(q.getCounters().drops).toBe(2); // sampled-out + eviction
  });

  it('per-call capture policy overrides the queue default', () => {
    const q = new MergedQueue({ capturePolicy: 'summary' });
    const live = { big: 'payload' };
    const ref = q.enqueue(input('scope', live), 'ref');
    expect(ref.envelope.payload).toBe(live);
    const summarized = q.enqueue(input('scope', live));
    expect((summarized.envelope.payload as PayloadSummary).__payloadSummary).toBe(true);
  });
});

describe('MergedQueue — functional', () => {
  it('merges realistic traffic from all three channels into one ordered stream', () => {
    const q = new MergedQueue();
    q.enqueue({ channel: 'scope', method: 'onWrite', runtimeStageId: 'seed#0', runId: 'r', payload: { key: 'a' } });
    q.enqueue({ channel: 'flow', method: 'onStageExecuted', runtimeStageId: 'seed#0', runId: 'r', payload: {} });
    q.enqueue({ channel: 'emit', method: 'onEmit', runtimeStageId: 'call#1', runId: 'r', payload: { name: 'x' } });
    q.enqueue({ channel: 'flow', method: 'onNext', runtimeStageId: 'call#1', runId: 'r', payload: {} });

    const drained = [q.shift(), q.shift(), q.shift(), q.shift()];
    expect(drained.map((e) => e?.channel)).toEqual(['scope', 'flow', 'emit', 'flow']);
    expect(drained.map((e) => e?.method)).toEqual(['onWrite', 'onStageExecuted', 'onEmit', 'onNext']);
    expect(drained.map((e) => e?.seq)).toEqual([0, 1, 2, 3]);
    expect(q.shift()).toBeUndefined();
  });
});

describe('MergedQueue — property', () => {
  it('B3: randomized 3-channel interleavings drain in arrival order (≥100 trials)', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...CHANNELS), { minLength: 1, maxLength: 200 }), (arrivals) => {
        const q = new MergedQueue(); // default capacity — nothing dropped here
        for (const channel of arrivals) q.enqueue(input(channel));

        const drained: Array<{ seq: number; channel: CaptureChannel }> = [];
        let e = q.shift();
        while (e !== undefined) {
          drained.push({ seq: e.seq, channel: e.channel });
          e = q.shift();
        }
        expect(drained.map((d) => d.channel)).toEqual(arrivals);
        expect(drained.map((d) => d.seq)).toEqual(arrivals.map((_, i) => i));
      }),
      { numRuns: 120 },
    );
  });

  it('drops leave visible seq gaps; gap count equals the drop counter', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        fc.array(fc.constantFrom(...CHANNELS), { minLength: 1, maxLength: 150 }),
        (maxQueue, arrivals) => {
          const q = new MergedQueue({ maxQueue, overflow: 'drop-oldest' });
          for (const channel of arrivals) q.enqueue(input(channel));

          const seqs: number[] = [];
          let e = q.shift();
          while (e !== undefined) {
            seqs.push(e.seq);
            e = q.shift();
          }
          for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
          const gaps = arrivals.length - seqs.length;
          expect(gaps).toBe(q.getCounters().drops);
        },
      ),
      { numRuns: 120 },
    );
  });
});

describe('MergedQueue — security', () => {
  it('queued envelopes are detached from live payloads (summary default)', () => {
    const q = new MergedQueue();
    const live = { secret: 'before' };
    q.enqueue(input('scope', live));
    live.secret = 'AFTER-MUTATION';
    const envelope = q.shift();
    expect(JSON.stringify(envelope)).not.toContain('AFTER-MUTATION');
  });

  it("the capture warn seam is plumbed through ('ref' surfaces to hooks.warn)", () => {
    const warnings: string[] = [];
    const q = new MergedQueue({ hooks: { warn: (m) => warnings.push(m) } });
    q.enqueue(input(), 'ref');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("'ref'");
  });
});

describe('MergedQueue — load', () => {
  it('sustains 50k enqueue/shift cycles with order + accounting intact', () => {
    const q = new MergedQueue({ maxQueue: 1_000 });
    const start = Date.now();
    let drained = 0;
    for (let i = 0; i < 50_000; i++) {
      q.enqueue(input(CHANNELS[i % 3], { i }));
      if (i % 2 === 1 && q.shift() !== undefined) drained += 1;
    }
    const c = q.getCounters();
    expect(c.pushes).toBe(50_000);
    expect(c.delivered).toBe(drained);
    expect(c.pushes).toBe(c.delivered + c.drops + c.rejections + q.depth);
    expect(Date.now() - start).toBeLessThan(2_000); // generous regression budget
  });
});
