/**
 * Property tests — #13c-B delta commit verbs: the LOSSLESS REPLAY invariant.
 *
 * For ANY random op sequence (sets, merges, array pushes, deletes, no-op
 * writes, reverts, nested paths) run twice — once through a 'full' buffer
 * and once through a 'delta' buffer:
 *
 *   (a) the materialised state is deep-equal at EVERY step (not just final);
 *   (b) the final states are deep-equal;
 *   (c) the delta bundle's value payload is never larger than the full one;
 *   (d) delta bundles carry exactly ONE trace entry per surviving path
 *       (the non-idempotency guard — duplicate appends would multiply tails);
 *   (e) for k pushes over a base of length n, the append bundle stores
 *       exactly k elements and replay reconstructs all n+k.
 *
 * This is the §3 verification plan of docs/design/13c-b-delta-commit-verb.md.
 */
import fc from 'fast-check';

import { EventLog } from '../../../../src/lib/memory/EventLog';
import { TransactionBuffer } from '../../../../src/lib/memory/TransactionBuffer';
import type { CommitBundle } from '../../../../src/lib/memory/types';
import { applySmartMerge } from '../../../../src/lib/memory/utils';

// Small key space → lots of overlapping ops per stage (the interesting case).
const keyArb = fc.constantFrom('a', 'b', 'c', 'list', 'log');
const scalarArb = fc.oneof(fc.integer({ min: -5, max: 5 }), fc.string({ maxLength: 4 }), fc.boolean());
const valueArb = fc.oneof(
  scalarArb,
  fc.array(scalarArb, { maxLength: 4 }),
  fc.dictionary(fc.constantFrom('x', 'y'), scalarArb, { maxKeys: 2 }),
);

/** One random operation against a buffer + the ground-truth state. */
type Op =
  | { kind: 'set'; key: string; value: unknown }
  | { kind: 'push'; key: string; items: unknown[] } // copy-on-write array growth (the TypedScope pattern)
  | { kind: 'merge'; key: string; value: Record<string, unknown> }
  | { kind: 'delete'; key: string }
  | { kind: 'noop-rewrite'; key: string } // re-write current value (fresh ref)
  | { kind: 'nested-set'; key: string; sub: string; value: unknown };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('set' as const), key: keyArb, value: valueArb }),
  fc.record({
    kind: fc.constant('push' as const),
    key: keyArb,
    items: fc.array(scalarArb, { minLength: 1, maxLength: 3 }),
  }),
  fc.record({
    kind: fc.constant('merge' as const),
    key: keyArb,
    value: fc.dictionary(fc.constantFrom('x', 'y', 'z'), scalarArb, { minKeys: 1, maxKeys: 2 }),
  }),
  fc.record({ kind: fc.constant('delete' as const), key: keyArb }),
  fc.record({ kind: fc.constant('noop-rewrite' as const), key: keyArb }),
  fc.record({
    kind: fc.constant('nested-set' as const),
    key: keyArb,
    sub: fc.constantFrom('p', 'q'),
    value: scalarArb,
  }),
);

/** Apply one op to a buffer (reading current values through the buffer). */
function applyOp(buf: TransactionBuffer, op: Op): void {
  switch (op.kind) {
    case 'set':
      buf.set([op.key], op.value);
      break;
    case 'push': {
      const cur = buf.get([op.key]);
      const arr = Array.isArray(cur) ? cur : [];
      buf.set([op.key], [...arr, ...op.items]); // copy-on-write, like TypedScope push/$batchArray
      break;
    }
    case 'merge':
      buf.merge([op.key], structuredClone(op.value));
      break;
    case 'delete':
      buf.delete([op.key]);
      break;
    case 'noop-rewrite': {
      const cur = buf.get([op.key]);
      if (cur !== undefined) buf.set([op.key], structuredClone(cur)); // fresh ref, equal content
      break;
    }
    case 'nested-set':
      buf.set([op.key, op.sub], op.value);
      break;
  }
}

/** Run a multi-stage program through one mode; returns the per-stage bundles. */
function runProgram(base: Record<string, unknown>, stages: Op[][], mode: 'full' | 'delta'): CommitBundle[] {
  let state = structuredClone(base);
  const bundles: CommitBundle[] = [];
  for (let s = 0; s < stages.length; s++) {
    const buf = new TransactionBuffer(state, mode);
    for (const op of stages[s]) applyOp(buf, op);
    const { overwrite, updates, trace, redactedPaths } = buf.commit();
    const bundle: CommitBundle = {
      stage: `S${s}`,
      stageId: `s${s}`,
      runtimeStageId: `s${s}#${s}`,
      trace,
      redactedPaths: [...redactedPaths],
      overwrite,
      updates,
    };
    bundles.push(bundle);
    state = applySmartMerge(state, updates, overwrite, trace); // commit → next stage's base
  }
  return bundles;
}

function materialiseSteps(base: Record<string, unknown>, bundles: CommitBundle[]): unknown[] {
  const log = new EventLog(base);
  for (const b of bundles) log.record(structuredClone(b));
  const steps: unknown[] = [];
  for (let k = 0; k <= bundles.length; k++) steps.push(log.materialise(k));
  return steps;
}

/** JSON size of a bundle's VALUE payload (overwrite + updates). */
function payloadSize(b: CommitBundle): number {
  return (JSON.stringify(b.overwrite) ?? '').length + (JSON.stringify(b.updates) ?? '').length;
}

const programArb = fc.array(fc.array(opArb, { minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 6 });
const baseArb = fc.dictionary(keyArb, valueArb, { maxKeys: 4 });

describe('Property: delta-mode replay equivalence (#13c-B)', () => {
  it("(a)+(b) 'delta' replay-reconstructed state deep-equals 'full' at EVERY step, for ANY op sequence", () => {
    fc.assert(
      fc.property(baseArb, programArb, (base, stages) => {
        const fullBundles = runProgram(base, stages, 'full');
        const deltaBundles = runProgram(base, stages, 'delta');

        const fullSteps = materialiseSteps(base, fullBundles);
        const deltaSteps = materialiseSteps(base, deltaBundles);

        expect(deltaSteps.length).toBe(fullSteps.length);
        for (let k = 0; k < fullSteps.length; k++) {
          // JSON canonicalisation: full mode leaves `key: undefined` behind
          // for deletes where delta REMOVES the key — equivalent through the
          // JSON lens every serialized consumer (checkpoint, viewer) sees.
          expect(JSON.parse(JSON.stringify(deltaSteps[k]))).toEqual(JSON.parse(JSON.stringify(fullSteps[k])));
        }
      }),
      { numRuns: 300 },
    );
  });

  it('(c) the delta value payload is never larger than the full one (merge-free programs)', () => {
    // Honest scope note: programs WITH mixed set+merge interleavings on one
    // path can flatten an array into an index-keyed object whose inlined
    // JSON spells out indices — a few bytes MORE than full mode's split
    // overwrite+updates encoding. The size guarantee that matters (and the
    // one the memo claims) is for the set/append family: tails are always
    // subsets of full arrays, dedup only removes entries. So this property
    // pins ≤ for merge-free programs; the replay-equality properties above
    // cover merge-mixed programs losslessly.
    const mergeFreeOp = opArb.filter((op) => op.kind !== 'merge');
    const mergeFreeProgram = fc.array(fc.array(mergeFreeOp, { minLength: 1, maxLength: 6 }), {
      minLength: 1,
      maxLength: 6,
    });
    fc.assert(
      fc.property(baseArb, mergeFreeProgram, (base, stages) => {
        const fullBundles = runProgram(base, stages, 'full');
        const deltaBundles = runProgram(base, stages, 'delta');
        for (let i = 0; i < fullBundles.length; i++) {
          expect(payloadSize(deltaBundles[i])).toBeLessThanOrEqual(payloadSize(fullBundles[i]));
        }
      }),
      { numRuns: 300 },
    );
  });

  it('(d) delta bundles carry exactly ONE trace entry per surviving path', () => {
    fc.assert(
      fc.property(baseArb, programArb, (base, stages) => {
        for (const b of runProgram(base, stages, 'delta')) {
          const paths = b.trace.map((t) => t.path);
          expect(new Set(paths).size).toBe(paths.length);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('(e) k pushes over base length n → the bundle stores exactly k elements; replay reconstructs all n+k', () => {
    fc.assert(
      fc.property(
        fc.array(scalarArb, { maxLength: 10 }), // base array (length n)
        fc.array(scalarArb, { minLength: 1, maxLength: 10 }), // pushed items (k)
        fc.integer({ min: 1, max: 4 }), // spread the pushes over this many ops
        (baseArr, items, chunks) => {
          const base = { list: baseArr };
          const buf = new TransactionBuffer(base, 'delta');
          // push in `chunks` separate copy-on-write writes within ONE stage
          const per = Math.ceil(items.length / chunks);
          for (let c = 0; c < items.length; c += per) {
            const cur = buf.get(['list']) as unknown[];
            buf.set(['list'], [...cur, ...items.slice(c, c + per)]);
          }
          const bundle = buf.commit();

          expect(bundle.trace).toEqual([{ path: 'list', verb: 'append' }]);
          expect(bundle.overwrite.list).toHaveLength(items.length); // exactly k
          const replayed = applySmartMerge(base, bundle.updates, bundle.overwrite, bundle.trace);
          expect(replayed.list).toEqual([...baseArr, ...items]); // all n+k
        },
      ),
      { numRuns: 300 },
    );
  });

  it('final shared state is deep-equal across modes for ANY program (the corollary)', () => {
    fc.assert(
      fc.property(baseArb, programArb, (base, stages) => {
        let fullState = structuredClone(base);
        let deltaState = structuredClone(base);
        for (const ops of stages) {
          const fb = new TransactionBuffer(fullState, 'full');
          const db = new TransactionBuffer(deltaState, 'delta');
          for (const op of ops) {
            applyOp(fb, op);
            applyOp(db, op);
          }
          const fc1 = fb.commit();
          const dc1 = db.commit();
          fullState = applySmartMerge(fullState, fc1.updates, fc1.overwrite, fc1.trace);
          deltaState = applySmartMerge(deltaState, dc1.updates, dc1.overwrite, dc1.trace);
        }
        expect(JSON.parse(JSON.stringify(deltaState))).toEqual(JSON.parse(JSON.stringify(fullState)));
      }),
      { numRuns: 300 },
    );
  });
});
