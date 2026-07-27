/**
 * Unit tests — #13c-B delta commit verbs (`commitValues: 'delta'`).
 *
 * Covers the three primitives in isolation:
 *   1. TransactionBuffer in 'delta' mode — append detection (strict array
 *      prefix → tail-only payload), `delete` verb, one-trace-entry-per-path
 *      dedup, and every fallback-to-`set` edge (first write, shrink,
 *      in-place mutation, reorder, mixed set+merge).
 *   2. TransactionBuffer in 'full' mode — byte-parity guards: staged
 *      `delete` ops commit as the historical set-of-undefined; duplicate
 *      trace entries are retained.
 *   3. The replay arms — `applySmartMerge` append (concat + non-array
 *      degrade) and delete (key removal); `nativeDelete`
 *      prototype-pollution safety.
 *
 * See docs/design/13c-b-delta-commit-verb.md.
 */
import { nativeDelete } from '../../../../src/lib/memory/pathOps';
import { TransactionBuffer } from '../../../../src/lib/memory/TransactionBuffer';
import { applySmartMerge, DELIM, redactPatch } from '../../../../src/lib/memory/utils';

describe('Unit: TransactionBuffer — delta mode (#13c-B)', () => {
  describe('append detection', () => {
    it('records ONLY the tail when the base array is a strict prefix of the final array', () => {
      const base = { history: [{ role: 'user', text: 'hi' }] };
      const buf = new TransactionBuffer(base, 'delta');
      buf.set(['history'], [...structuredClone(base.history), { role: 'assistant', text: 'hello' }]);
      const bundle = buf.commit();

      expect(bundle.trace).toEqual([{ path: 'history', verb: 'append' }]);
      expect(bundle.overwrite.history).toEqual([{ role: 'assistant', text: 'hello' }]); // tail only
      expect(bundle.updates).toEqual({});
    });

    it('multi-element tails record every new element, in order', () => {
      const buf = new TransactionBuffer({ tags: ['a'] }, 'delta');
      buf.set(['tags'], ['a', 'b', 'c', 'd']);
      const bundle = buf.commit();
      expect(bundle.trace).toEqual([{ path: 'tags', verb: 'append' }]);
      expect(bundle.overwrite.tags).toEqual(['b', 'c', 'd']);
    });

    it('first write of an array (base undefined) stays a SET — the causal init anchor', () => {
      const buf = new TransactionBuffer({}, 'delta');
      buf.set(['history'], [1, 2, 3]);
      const bundle = buf.commit();
      expect(bundle.trace).toEqual([{ path: 'history', verb: 'set' }]);
      expect(bundle.overwrite.history).toEqual([1, 2, 3]);
    });

    it('append from an EMPTY base array is an append (base [] is a strict prefix)', () => {
      const buf = new TransactionBuffer({ history: [] }, 'delta');
      buf.set(['history'], [1]);
      const bundle = buf.commit();
      expect(bundle.trace).toEqual([{ path: 'history', verb: 'append' }]);
      expect(bundle.overwrite.history).toEqual([1]);
    });

    it('shrink falls back to a full-value set', () => {
      const buf = new TransactionBuffer({ tags: ['a', 'b', 'c'] }, 'delta');
      buf.set(['tags'], ['a', 'b']);
      const bundle = buf.commit();
      expect(bundle.trace).toEqual([{ path: 'tags', verb: 'set' }]);
      expect(bundle.overwrite.tags).toEqual(['a', 'b']);
    });

    it('in-place element mutation falls back to a full-value set (prefix diverges)', () => {
      const buf = new TransactionBuffer({ tags: [{ v: 1 }, { v: 2 }] }, 'delta');
      buf.set(['tags'], [{ v: 1 }, { v: 99 }, { v: 3 }]);
      const bundle = buf.commit();
      expect(bundle.trace).toEqual([{ path: 'tags', verb: 'set' }]);
      expect(bundle.overwrite.tags).toEqual([{ v: 1 }, { v: 99 }, { v: 3 }]);
    });

    it('reorder falls back to a full-value set', () => {
      const buf = new TransactionBuffer({ tags: ['a', 'b'] }, 'delta');
      buf.set(['tags'], ['b', 'a', 'c']);
      const bundle = buf.commit();
      expect(bundle.trace).toEqual([{ path: 'tags', verb: 'set' }]);
    });

    it('same-length equal array is a NO-OP (dropped), not an append', () => {
      const buf = new TransactionBuffer({ tags: ['a', 'b'] }, 'delta');
      buf.set(['tags'], ['a', 'b']);
      const bundle = buf.commit();
      expect(bundle.trace).toHaveLength(0);
      expect(bundle.overwrite).toEqual({});
    });

    it('non-array values never append', () => {
      const buf = new TransactionBuffer({ name: 'ab' }, 'delta');
      buf.set(['name'], 'abc'); // string "prefix growth" must NOT be an append
      const bundle = buf.commit();
      expect(bundle.trace).toEqual([{ path: 'name', verb: 'set' }]);
      expect(bundle.overwrite.name).toBe('abc');
    });

    it('detects appends on nested DELIM paths', () => {
      const buf = new TransactionBuffer({ runs: { r1: { history: [1] } } }, 'delta');
      buf.set(['runs', 'r1', 'history'], [1, 2]);
      const bundle = buf.commit();
      expect(bundle.trace).toEqual([{ path: ['runs', 'r1', 'history'].join(DELIM), verb: 'append' }]);
      expect(bundle.overwrite.runs.r1.history).toEqual([2]);
    });
  });

  describe('one-trace-entry-per-path dedup (§2.5)', () => {
    it('three pushes in one stage yield ONE append entry with the full tail (never k tails)', () => {
      const buf = new TransactionBuffer({ history: [0] }, 'delta');
      buf.set(['history'], [0, 1]);
      buf.set(['history'], [0, 1, 2]);
      buf.set(['history'], [0, 1, 2, 3]);
      const bundle = buf.commit();

      expect(bundle.trace).toEqual([{ path: 'history', verb: 'append' }]);
      expect(bundle.overwrite.history).toEqual([1, 2, 3]); // tail vs BASE, not vs last write

      // Replay exactly once — non-idempotency guard: a duplicated entry
      // would have concatenated the tail twice.
      const replayed = applySmartMerge({ history: [0] }, bundle.updates, bundle.overwrite, bundle.trace);
      expect(replayed).toEqual({ history: [0, 1, 2, 3] });
    });

    it('every delta bundle has unique trace paths across mixed ops', () => {
      const buf = new TransactionBuffer({ a: 1, list: [1] }, 'delta');
      buf.set(['a'], 2);
      buf.merge(['obj'], { x: 1 });
      buf.set(['a'], 3);
      buf.set(['list'], [1, 2]);
      buf.merge(['obj'], { y: 2 });
      const bundle = buf.commit();
      const paths = bundle.trace.map((t) => t.path);
      expect(new Set(paths).size).toBe(paths.length);
    });

    it("orders entries by each path's LAST touch (nested overlapping paths replay correctly)", () => {
      // set a.b then set a — 'a' must replay AFTER 'a.b' (last-writer-wins).
      const buf = new TransactionBuffer({ a: { b: 0 } }, 'delta');
      buf.set(['a', 'b'], 1);
      buf.set(['a'], { b: 2, c: 3 });
      const bundle = buf.commit();
      expect(bundle.trace.map((t) => t.path)).toEqual([['a', 'b'].join(DELIM), 'a']);
      const replayed = applySmartMerge({ a: { b: 0 } }, bundle.updates, bundle.overwrite, bundle.trace);
      expect(replayed).toEqual({ a: { b: 2, c: 3 } });
    });

    it('mixed set+merge on one path resolves to ONE set of the FINAL value (not the stale overwritePatch)', () => {
      const buf = new TransactionBuffer({}, 'delta');
      buf.set(['cfg'], 1); // overwritePatch.cfg = 1 (stale after the merge)
      buf.merge(['cfg'], { x: 1 }); // workingCopy.cfg = { x: 1 }
      const bundle = buf.commit();
      expect(bundle.trace).toEqual([{ path: 'cfg', verb: 'set' }]);
      expect(bundle.overwrite.cfg).toEqual({ x: 1 });
      expect(bundle.updates).toEqual({});
    });

    it('pure-merge paths keep the merge verb with the accumulated delta', () => {
      const buf = new TransactionBuffer({ cfg: { a: 1 } }, 'delta');
      buf.merge(['cfg'], { b: 2 });
      buf.merge(['cfg'], { c: 3 });
      const bundle = buf.commit();
      expect(bundle.trace).toEqual([{ path: 'cfg', verb: 'merge' }]);
      expect(bundle.updates.cfg).toEqual({ b: 2, c: 3 });
      expect(bundle.overwrite).toEqual({});
    });
  });

  describe('overlapping paths in ONE commit (the patch bag is a TREE)', () => {
    /**
     * Commit the same ops through both modes and replay each bundle. Cross-mode
     * state equality is the invariant every delta encoding owes: `overwrite` /
     * `updates` are nested path TREES, so an entry for `a` and an entry for
     * `a.p` share storage — and delta's encodings (append = TAIL only, delete =
     * `undefined` marker) are not the full value at their path, so a naive
     * per-path encoding lets one entry destroy the other.
     *
     * `ops` runs twice, so it must build its own values — `set` keeps the RAW
     * reference in workingCopy (see the class landmine).
     */
    function replayBothModes(base: Record<string, unknown>, ops: (buf: TransactionBuffer) => void) {
      const commitOf = (mode: 'full' | 'delta') => {
        const buf = new TransactionBuffer(base, mode);
        ops(buf);
        return buf.commit();
      };
      const fullBundle = commitOf('full');
      const deltaBundle = commitOf('delta');
      return {
        fullBundle,
        deltaBundle,
        fullState: applySmartMerge(base, fullBundle.updates, fullBundle.overwrite, fullBundle.trace),
        deltaState: applySmartMerge(base, deltaBundle.updates, deltaBundle.overwrite, deltaBundle.trace),
      };
    }

    it('a push + a nested write on the SAME key keeps both (pinned counterexample, seed -1006859621)', () => {
      const { fullState, deltaState } = replayBothModes({ a: [false] }, (buf) => {
        buf.set(['a'], [...(buf.get(['a']) as unknown[]), false]); // append-shaped
        buf.set(['a', 'p'], 0); // nested write INTO the appended array
        buf.set(['a'], structuredClone(buf.get(['a']))); // no-op rewrite
      });
      // Delta used to encode `a` as an append (tail only) and then write
      // `a.p` into that TAIL — the nested write was gone at replay.
      expect((deltaState.a as Record<string, unknown>).p).toBe(0);
      expect(deltaState).toEqual(fullState);
    });

    it('a nested write inside a freshly appended element never corrupts the tail (indices are shifted)', () => {
      const { fullState, deltaState, deltaBundle } = replayBothModes({ history: [{ v: 1 }] }, (buf) => {
        buf.set(['history'], [...(buf.get(['history']) as unknown[]), { v: 2 }]);
        buf.set(['history', '1', 'w'], 5); // index 1 of the ARRAY = index -1 of the tail
      });
      expect(deltaState.history).toHaveLength(2); // a tail-relative write used to add a phantom element
      expect(deltaState).toEqual(fullState);
      expect(deltaBundle.trace.every((t) => t.verb === 'set')).toBe(true); // family → full-value fallback
    });

    it('an array that grew a NAMED property never appends — replay spreads the tail and would drop it', () => {
      const { fullState, deltaState, deltaBundle } = replayBothModes({ history: ['a'] }, (buf) => {
        buf.set(['history'], ['a', 'b']); // looks like an append…
        buf.delete(['history', 'note']); // …but parks a named key on the array (nets nothing at its OWN path)
      });
      expect(deltaBundle.trace).toEqual([{ path: 'history', verb: 'set' }]);
      expect(Object.prototype.hasOwnProperty.call(deltaState.history, 'note')).toBe(true);
      expect(deltaState).toEqual(fullState);
    });

    it('a nested delete under a NON-container parent keeps the historical flattening', () => {
      // nativeDelete walks away from a string parent; the 'full' flattening
      // (_set of undefined) COERCES it into an object. Committing `delete`
      // there would silently drop a change the stage really made.
      const { fullState, deltaState, deltaBundle } = replayBothModes({ b: 'yy' }, (buf) => {
        buf.delete(['b', '1']);
      });
      expect(deltaBundle.trace).toEqual([{ path: ['b', '1'].join(DELIM), verb: 'set' }]);
      expect(deltaState).toEqual(fullState);
      expect(typeof deltaState.b).toBe('object');
    });

    it('merge + nested set on one key commit ONE coherent value', () => {
      const { fullState, deltaState } = replayBothModes({ cfg: { a: 1 } }, (buf) => {
        buf.merge(['cfg'], { b: 2 });
        buf.set(['cfg', 'c'], 3);
      });
      expect(deltaState).toEqual({ cfg: { a: 1, b: 2, c: 3 } });
      expect(deltaState).toEqual(fullState);
    });

    it('3-level families and delete-inside-a-family stay in lockstep with full mode', () => {
      const deep = replayBothModes({ a: { b: { c: 1, keep: 'x' } } }, (buf) => {
        buf.set(['a', 'b', 'c'], 2);
        buf.set(['a'], { b: { c: 3, d: 4 } }); // whole-key set between two nested writes
        buf.set(['a', 'b', 'd'], 5);
      });
      expect(deep.deltaState).toEqual({ a: { b: { c: 3, d: 5 } } });
      expect(deep.deltaState).toEqual(deep.fullState);

      const removed = replayBothModes({ a: { p: 1, q: 2 } }, (buf) => {
        buf.delete(['a', 'p']);
        buf.set(['a'], { q: 3 });
      });
      expect(removed.deltaState).toEqual({ a: { q: 3 } });
      expect(removed.deltaState).toEqual(removed.fullState);
    });

    it('UNRELATED nested paths are not a family — a plain push still appends (no size regression)', () => {
      const { fullState, deltaState, deltaBundle } = replayBothModes({ history: ['a'], meta: {} }, (buf) => {
        buf.set(['history'], ['a', 'b']);
        buf.set(['meta', 'note'], 1); // different subtree — cannot collide
      });
      expect(deltaBundle.trace).toContainEqual({ path: 'history', verb: 'append' });
      expect(deltaBundle.overwrite.history).toEqual(['b']); // tail only
      expect(deltaState).toEqual(fullState);
    });
  });

  describe('delete verb', () => {
    it('an explicit delete commits verb "delete" and still ENUMERATES the path in overwrite', () => {
      const buf = new TransactionBuffer({ secret: 'x', keep: 1 }, 'delta');
      buf.delete(['secret']);
      const bundle = buf.commit();

      expect(bundle.trace).toEqual([{ path: 'secret', verb: 'delete' }]);
      // Key-set consumers (lens overwriteKeys) keep seeing the changed key:
      expect(Object.prototype.hasOwnProperty.call(bundle.overwrite, 'secret')).toBe(true);
      expect(bundle.overwrite.secret).toBeUndefined();
    });

    it('replaying a delete REMOVES the key (closes the set-undefined flattening, B8)', () => {
      const buf = new TransactionBuffer({ secret: 'x', keep: 1 }, 'delta');
      buf.delete(['secret']);
      const bundle = buf.commit();
      const replayed = applySmartMerge({ secret: 'x', keep: 1 }, bundle.updates, bundle.overwrite, bundle.trace);
      expect(Object.prototype.hasOwnProperty.call(replayed, 'secret')).toBe(false);
      expect(replayed).toEqual({ keep: 1 });
    });

    it('deleting an ABSENT key is a no-op (dropped from the bundle)', () => {
      const buf = new TransactionBuffer({ keep: 1 }, 'delta');
      buf.delete(['ghost']);
      const bundle = buf.commit();
      expect(bundle.trace).toHaveLength(0);
    });

    it('set-then-delete in one stage nets to a delete; delete-then-set nets to a set', () => {
      const b1 = new TransactionBuffer({ k: 1 }, 'delta');
      b1.set(['k'], 2);
      b1.delete(['k']);
      const bundle1 = b1.commit();
      expect(bundle1.trace).toEqual([{ path: 'k', verb: 'delete' }]);

      const b2 = new TransactionBuffer({ k: 1 }, 'delta');
      b2.delete(['k']);
      b2.set(['k'], 5);
      const bundle2 = b2.commit();
      expect(bundle2.trace).toEqual([{ path: 'k', verb: 'set' }]);
      expect(bundle2.overwrite.k).toBe(5);
    });
  });

  describe("'full' mode byte-parity guards", () => {
    it('a staged delete commits as the historical set-of-undefined', () => {
      const buf = new TransactionBuffer({ secret: 'x' }); // default 'full'
      buf.delete(['secret']);
      const bundle = buf.commit();
      expect(bundle.trace).toEqual([{ path: 'secret', verb: 'set' }]);
      expect(Object.prototype.hasOwnProperty.call(bundle.overwrite, 'secret')).toBe(true);
      expect(bundle.overwrite.secret).toBeUndefined();
      // Historical replay semantics: key stays, value becomes undefined.
      const replayed = applySmartMerge({ secret: 'x' }, bundle.updates, bundle.overwrite, bundle.trace);
      expect(Object.prototype.hasOwnProperty.call(replayed, 'secret')).toBe(true);
    });

    it('keeps duplicate trace entries and full-array payloads (no delta behavior leaks)', () => {
      const buf = new TransactionBuffer({ history: [0] }); // default 'full'
      buf.set(['history'], [0, 1]);
      buf.set(['history'], [0, 1, 2]);
      const bundle = buf.commit();
      expect(bundle.trace).toEqual([
        { path: 'history', verb: 'set' },
        { path: 'history', verb: 'set' },
      ]);
      expect(bundle.overwrite.history).toEqual([0, 1, 2]); // full final array
    });
  });

  describe('redaction interaction', () => {
    it('redacted append paths survive into redactedPaths so the commit pipeline scrubs the tail', () => {
      const buf = new TransactionBuffer({ history: ['a'] }, 'delta');
      buf.set(['history'], ['a', 'pii-message'], true);
      const bundle = buf.commit();
      expect(bundle.trace).toEqual([{ path: 'history', verb: 'append' }]);
      expect([...bundle.redactedPaths]).toEqual(['history']);
      expect(bundle.overwrite.history).toEqual(['pii-message']); // raw tail — redactPatch scrubs downstream
    });

    it('a redacted nested write inside an overlapping family never leaks through its ancestor entry', () => {
      // The family fallback commits the ancestor's WHOLE value, which contains
      // the redacted leaf — but both live in one patch tree, so redactPatch
      // scrubs the leaf once and every entry that covers it sees 'REDACTED'.
      const base = { a: { p: 'old', q: 1 } };
      const buf = new TransactionBuffer(base, 'delta');
      buf.set(['a'], { p: 'SECRET', q: 2 });
      buf.set(['a', 'p'], 'SECRET', true);
      const bundle = buf.commit();

      const mirror = applySmartMerge(
        base,
        bundle.updates,
        redactPatch(bundle.overwrite, bundle.redactedPaths),
        bundle.trace,
      );
      expect(JSON.stringify(mirror)).not.toContain('SECRET');
      expect(mirror).toEqual({ a: { p: 'REDACTED', q: 2 } });
      // …while the real commit still carries the real value.
      expect(applySmartMerge(base, bundle.updates, bundle.overwrite, bundle.trace)).toEqual({
        a: { p: 'SECRET', q: 2 },
      });
    });

    it('redacted delete paths survive into redactedPaths', () => {
      const buf = new TransactionBuffer({ secret: 'x' }, 'delta');
      buf.delete(['secret'], true);
      const bundle = buf.commit();
      expect([...bundle.redactedPaths]).toEqual(['secret']);
    });
  });
});

describe('Unit: applySmartMerge — append/delete replay arms (#13c-B)', () => {
  it('append concatenates the tail onto the current array', () => {
    const out = applySmartMerge({ history: [1, 2] }, {}, { history: [3, 4] }, [{ path: 'history', verb: 'append' }]);
    expect(out).toEqual({ history: [1, 2, 3, 4] });
  });

  it('append onto a missing/non-array base degrades to a direct set of the tail', () => {
    const out = applySmartMerge({}, {}, { history: [3] }, [{ path: 'history', verb: 'append' }]);
    expect(out).toEqual({ history: [3] });
    const out2 = applySmartMerge({ history: 'corrupt' }, {}, { history: [3] }, [{ path: 'history', verb: 'append' }]);
    expect(out2).toEqual({ history: [3] });
  });

  it('append with a REDACTED (non-array) tail degrades to the redacted value — never spreads the string', () => {
    // The redacted mirror replays redactPatch output, where a matched tail is
    // the string 'REDACTED'. It must become the terminal value, NOT be
    // spread char-by-char into the existing array.
    const out = applySmartMerge({ history: ['real-msg'] }, {}, { history: 'REDACTED' }, [
      { path: 'history', verb: 'append' },
    ]);
    expect(out).toEqual({ history: 'REDACTED' });
  });

  it('delete removes the key from the replayed state', () => {
    const out = applySmartMerge({ a: 1, b: 2 }, {}, { a: undefined }, [{ path: 'a', verb: 'delete' }]);
    expect(Object.prototype.hasOwnProperty.call(out, 'a')).toBe(false);
    expect(out).toEqual({ b: 2 });
  });

  it('delete of a nested path removes only the leaf', () => {
    const out = applySmartMerge({ a: { b: 1, c: 2 } }, {}, {}, [{ path: ['a', 'b'].join(DELIM), verb: 'delete' }]);
    expect(out).toEqual({ a: { c: 2 } });
  });

  it('the tail in the replayed state is DETACHED from the bundle (clone, not alias)', () => {
    const overwrite = { history: [{ v: 1 }] };
    const out = applySmartMerge({ history: [] }, {}, overwrite, [{ path: 'history', verb: 'append' }]);
    out.history[0].v = 99;
    expect(overwrite.history[0].v).toBe(1);
  });
});

describe('Unit: nativeDelete — prototype-pollution safety (security tier)', () => {
  it('removes own properties at flat and nested paths', () => {
    const obj: any = { a: 1, b: { c: 2, d: 3 } };
    nativeDelete(obj, ['a']);
    nativeDelete(obj, ['b', 'c']);
    expect(obj).toEqual({ b: { d: 3 } });
  });

  it('is a no-op for absent intermediate segments', () => {
    const obj: any = { a: 1 };
    nativeDelete(obj, ['x', 'y']);
    expect(obj).toEqual({ a: 1 });
  });

  it('refuses DENIED segments (__proto__, constructor, prototype) at every position', () => {
    const obj: any = { a: { b: 1 } };
    nativeDelete(obj, ['__proto__']);
    nativeDelete(obj, ['constructor']);
    nativeDelete(obj, ['a', 'prototype']);
    nativeDelete(obj, ['__proto__', 'toString']);
    expect(Object.prototype.toString).toBeDefined();
    expect(obj.a).toEqual({ b: 1 });
    expect(({} as any).b).toBeUndefined(); // no pollution
  });

  it('never walks the prototype chain (inherited keys are not deletable)', () => {
    const proto = { inherited: 1 };
    const obj = Object.create(proto);
    obj.own = 2;
    nativeDelete(obj, ['inherited']);
    expect(proto.inherited).toBe(1);
  });
});
