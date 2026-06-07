/**
 * Performance regression guard for change-only commit detection.
 *
 * The change-only commit does one deepEqual per touched path at commit time.
 * This test pins the WORST case — a stage that re-writes 1000 small object
 * values with fresh-but-equal content, forcing a full deep compare of every
 * path that then prunes to an empty commit — under a deliberately generous
 * budget. It is a regression guard (catch an accidental O(n²) or per-write
 * blow-up), NOT a micro-benchmark; the threshold is loose on purpose so it
 * stays green under CI contention.
 *
 * See docs/design/commit-change-semantics.md.
 */
import { TransactionBuffer } from '../../../../src/lib/memory/TransactionBuffer';

describe('Boundary: change-only commit performance', () => {
  it('deep-compares 1000 small keys and prunes to empty under budget', () => {
    const base: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) {
      base[`key${i}`] = { id: i, tags: ['a', 'b', 'c'], meta: { score: i, ok: true } };
    }

    const buf = new TransactionBuffer(structuredClone(base));
    // Worst case: every write is a no-op with a FRESH reference, so the `===`
    // fast path never fires and each path is fully walked, then pruned.
    for (let i = 0; i < 1000; i++) {
      buf.set([`key${i}`], structuredClone(base[`key${i}`]));
    }

    const start = performance.now();
    const bundle = buf.commit();
    const elapsed = performance.now() - start;

    expect(bundle.trace).toHaveLength(0); // all no-ops pruned → empty commit
    expect(bundle.overwrite).toEqual({});
    expect(elapsed).toBeLessThan(500); // generous; typical is single-digit ms
  });

  it('a half-changed stage records exactly the changed half', () => {
    const base: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) base[`key${i}`] = i;

    const buf = new TransactionBuffer(structuredClone(base));
    for (let i = 0; i < 1000; i++) {
      // even keys unchanged (no-op), odd keys bumped (real change)
      buf.set([`key${i}`], i % 2 === 0 ? i : i + 1);
    }
    const bundle = buf.commit();

    expect(bundle.trace).toHaveLength(500);
    expect(Object.keys(bundle.overwrite)).toHaveLength(500);
    expect(bundle.overwrite.key1).toBe(2);
    expect(bundle.overwrite).not.toHaveProperty('key0');
  });
});
