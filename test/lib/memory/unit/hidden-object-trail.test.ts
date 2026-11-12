/**
 * One frame's side of "a hidden object keeps its rule wherever the stage puts it"
 * (`memory/hiddenObjectTrail.ts`), unit, through the frame that owns it (`StageContext`).
 *
 * What is pinned here: what the frame hands the search at a write, the second search at commit and the
 * one job it has (find what was put in AFTER the write, change no other record), and what a discarded
 * try leaves behind. The search itself is `selected-objects.test.ts`.
 */
import { EventLog, SharedMemory } from 'foottrace/write';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLEAR, RedactionRule } from '../../../../src/lib/memory/redaction';
import { SelectedObjects } from '../../../../src/lib/memory/selectedObjects';
import { StageContext } from '../../../../src/lib/memory/StageContext';

describe('the frame — it hands the search what the key holds now', () => {
  afterEach(() => vi.restoreAllMocks());

  function frame(rule: RedactionRule, state: Record<string, unknown>) {
    const heap = new SharedMemory(undefined, state);
    const ctx = new StageContext('', 's', 's', heap, '', new EventLog(heap.getState()));
    ctx.useRedactionRule(rule);
    return ctx;
  }

  it('a write is searched against the value it replaces, so that only what is new costs anything', () => {
    const ctx = frame(new RedactionRule({ keys: ['profile'] }), { profile: { name: 'Ada' }, list: [{ id: 1 }] });
    const findIn = vi.spyOn(SelectedObjects.prototype, 'findIn');
    ctx.getValue([], 'profile'); // a read under a hidden name: from here on the frame searches its writes
    const list = ctx.getValue([], 'list') as object[];
    const next = [...list, { id: 2 }];
    ctx.setObject([], 'list', next);
    expect(findIn).toHaveBeenCalledTimes(1);
    expect(findIn.mock.calls[0][0]).toBe(next);
    expect(findIn.mock.calls[0][1]).toBe(list); // the same object the key holds, not a copy
  });

  it('the SAME object written back is searched whole: a stage does that after changing it in place', () => {
    const ctx = frame(new RedactionRule({ keys: ['profile'] }), { profile: { name: 'Ada' } });
    const profile = ctx.getValue([], 'profile');
    const box: Record<string, unknown> = { x: 1 };
    expect(ctx.setObject([], 'box', box)).toBe(CLEAR);
    box.owner = profile; // in place
    const findIn = vi.spyOn(SelectedObjects.prototype, 'findIn');
    expect(ctx.setObject([], 'box', box)).toEqual({ kind: 'fields', key: 'box', paths: ['owner'] });
    expect(findIn.mock.calls[0][1]).toBeUndefined(); // nothing to compare against: all of it is searched
  });

  it('what a stage puts into an object AFTER writing it is found at commit, and the record hides it', () => {
    const rule = new RedactionRule({ keys: ['profile'] });
    const heap = new SharedMemory(undefined, { profile: { name: 'Ada' } });
    const log = new EventLog(heap.getState());
    const ctx = new StageContext('', 's', 's', heap, '', log);
    ctx.useRedactionRule(rule);
    const profile = ctx.getValue([], 'profile');
    const box: Record<string, unknown> = { x: 1 };
    ctx.setObject([], 'box', box);
    box.owner = profile; // no write shows this
    ctx.commit();
    expect(rule.verdict(['box'])).toEqual({ kind: 'fields', key: 'box', paths: ['owner'] });
    const bundle = log.recorded().at(-1);
    expect(JSON.stringify(bundle)).not.toContain('Ada');
    expect((heap.getState().box as { owner: unknown }).owner).toEqual({ name: 'Ada' }); // live state is real
  });

  it('a commit that finds nothing new leaves the record as the writes made it', () => {
    const rule = new RedactionRule({ keys: ['profile'] });
    const heap = new SharedMemory(undefined, { profile: { name: 'Ada' }, box: { x: 1 } });
    const log = new EventLog(heap.getState());
    const ctx = new StageContext('', 's', 's', heap, '', log);
    ctx.useRedactionRule(rule);
    const profile = ctx.getValue([], 'profile');
    ctx.updateObject([], 'box', { owner: profile }); // a merge, found when it was written
    ctx.commit();
    const bundle = log.recorded().at(-1) as { trace: { path: string; verb: string }[] };
    expect(bundle.trace.map((row) => row.verb)).toEqual(['merge']); // not staged again as a set
  });

  it('one object the stage itself put under a public name and a hidden name is not followed back in time', () => {
    // `b` is hidden by the policy, `hist` is not. The stage writes the same object under both and reads
    // it back under the hidden name. It was public where it already sat: `hist` stays as it is.
    const rule = new RedactionRule({ keys: ['b'] });
    const heap = new SharedMemory();
    const log = new EventLog(heap.getState());
    const ctx = new StageContext('', 's', 's', heap, '', log);
    ctx.useRedactionRule(rule);
    const shared = { note: 'public' };
    ctx.setObject([], 'hist', shared);
    ctx.setObject([], 'b', shared);
    ctx.getValue([], 'b');
    ctx.commit();
    expect(rule.verdict(['hist'])).toBe(CLEAR);
    expect((log.recorded().at(-1) as { overwrite: Record<string, unknown> }).overwrite.hist).toEqual({
      note: 'public',
    });
    // What the stage writes AFTER reading it back is followed as any hidden object is.
    const next = new StageContext('', 't', 't', heap, '', log);
    next.useRedactionRule(rule);
    const read = next.getValue([], 'b');
    expect(next.setObject([], 'copy', { held: read })).toEqual({ kind: 'fields', key: 'copy', paths: ['held'] });
  });

  it('a read with no key hands the stage everything: each selected value in it is remembered', () => {
    const rule = new RedactionRule({ keys: ['profile'], fields: { card: ['number'] } });
    const heap = new SharedMemory(undefined, {
      profile: { name: 'Ada' },
      card: { number: '4242', owner: { name: 'Ada' } },
      open: { note: 'n' },
      runs: { b1: { profile: { name: 'Bea' } } },
    });
    const ctx = new StageContext('', 's', 's', heap, '', new EventLog(heap.getState()));
    ctx.useRedactionRule(rule);
    const state = ctx.getValue([]) as Record<string, any>; // the whole state
    expect(ctx.setObject([], 'a', { held: state.profile })).toEqual({ kind: 'fields', key: 'a', paths: ['held'] });
    expect(ctx.setObject([], 'b', { held: state.card })).toEqual({ kind: 'fields', key: 'b', paths: ['held.number'] });
    expect(ctx.setObject([], 'c', { held: state.runs.b1.profile })).toEqual({
      kind: 'fields',
      key: 'c',
      paths: ['held'],
    });
    expect(ctx.setObject([], 'd', { held: state.open })).toBe(CLEAR);

    // And a read of a path with no key: the value at a selected path.
    const other = new StageContext('', 't', 't', heap, '', new EventLog(heap.getState()));
    other.useRedactionRule(rule);
    const profile = other.getValue(['profile']);
    expect(other.setObject([], 'e', [profile])).toEqual({ kind: 'whole', key: 'e' });
  });

  it('a place the record cannot name is cut back to the keys above it, and everything there is hidden', () => {
    const rule = new RedactionRule({ keys: ['profile'], fields: { card: ['number'] } });
    const ctx = frame(rule, { profile: { name: 'Ada' }, card: { number: '4242' } });
    const profile = ctx.getValue([], 'profile');
    const card = ctx.getValue([], 'card');
    // A key the record's scrub refuses to reach: the place above it.
    expect(ctx.setObject([], 'a', { inner: { constructor: profile, x: 1 } })).toEqual({
      kind: 'fields',
      key: 'a',
      paths: ['inner'],
    });
    expect(ctx.setObject([], 'b', { prototype: profile })).toEqual({ kind: 'whole', key: 'b' });
    expect(ctx.setObject([], 'c', JSON.parse('{"__proto__":{"deep":1}}'))).toBe(CLEAR); // nothing hidden in it
    // One key with a dot in it is a field of its own. Below it, or above it, a dotted key cannot be spelled.
    expect(ctx.setObject([], 'd', { 'x.y': profile, z: 1 })).toEqual({ kind: 'fields', key: 'd', paths: ['x.y'] });
    expect(ctx.setObject([], 'e', { 'x.y': { deep: profile } })).toEqual({ kind: 'whole', key: 'e' });
    expect(ctx.setObject([], 'f', { up: { 'x.y': profile } })).toEqual({ kind: 'fields', key: 'f', paths: ['up'] });
    // A record hidden by its fields, under a dotted key: its fields cannot be spelled there, so all of it.
    expect(ctx.setObject([], 'g', { 'x.y': card })).toEqual({ kind: 'fields', key: 'g', paths: ['x.y'] });
  });

  it('one frame that writes a key of one name at two places has both searched at commit', () => {
    // A frame in a run namespace writes `box` at its own address and, as a mount's merge-back does, at
    // the root. Both are the frame's writes, and a hidden object put into either afterwards is found.
    const rule = new RedactionRule({ keys: ['profile'] });
    const heap = new SharedMemory(undefined, { profile: { name: 'Ada' } });
    const log = new EventLog(heap.getState());
    const ctx = new StageContext('b1', 'branch', 'branch', heap, 'b1', log);
    ctx.useRedactionRule(rule);
    const profile = ctx.getValue([], 'profile');
    const mine: Record<string, unknown> = { x: 1 };
    const atRoot: Record<string, unknown> = { x: 2 };
    ctx.setObject([], 'box', mine); // runs/b1/box
    ctx.setGlobal('box', atRoot); // box, at the root
    mine.p = profile;
    atRoot.q = profile;
    ctx.commit();
    expect(JSON.stringify(log.recorded().at(-1))).not.toContain('Ada');
    const hidden = rule.verdict(['box']) as { kind: string; paths: string[] };
    expect(hidden.kind).toBe('fields');
    expect([...hidden.paths].sort()).toEqual(['p', 'q']);
  });

  it('a place that is hidden already is not handed a second rule', () => {
    const rule = new RedactionRule({ keys: ['profile'], fields: { card: ['holder'] } });
    const ctx = frame(rule, { profile: { name: 'Ada' }, card: { holder: { name: 'Ada' }, number: 1 } });
    const profile = ctx.getValue([], 'profile');
    // `card.holder` is hidden by the policy. A hidden object put at it, or below it, adds nothing.
    expect(ctx.setObject([], 'card', { holder: profile, number: 2 })).toEqual({
      kind: 'fields',
      key: 'card',
      paths: ['holder'],
    });
    expect(ctx.setObject([], 'card', { holder: { inner: profile }, number: 3 })).toEqual({
      kind: 'fields',
      key: 'card',
      paths: ['holder'],
    });
    expect(rule.marksForCheckpoint()).toBeUndefined(); // the policy's field covers both: nothing was handed on
  });

  it('a frame that read nothing hidden searches nothing', () => {
    const ctx = frame(new RedactionRule({ keys: ['profile'] }), { profile: { name: 'Ada' }, list: [{ id: 1 }] });
    const findIn = vi.spyOn(SelectedObjects.prototype, 'findIn');
    ctx.setObject([], 'list', [{ id: 2 }]);
    expect(findIn).not.toHaveBeenCalled();
  });

  it('a hidden object the frame read is found in what it writes, at a nested path too', () => {
    const rule = new RedactionRule({ keys: ['profile'] });
    const ctx = frame(rule, { profile: { name: 'Ada' }, box: { x: 1 } });
    const profile = ctx.getValue([], 'profile');
    expect(ctx.setObject([], 'box', { x: 1, owner: profile })).toEqual({
      kind: 'fields',
      key: 'box',
      paths: ['owner'],
    });
    expect(ctx.setObject(['card'], 'holder', profile)).toEqual({ kind: 'whole', key: 'card.holder' });
    expect(rule.verdict(['card'])).toEqual({ kind: 'fields', key: 'card', paths: ['holder'] });
  });

  it('a frame that read nothing hidden keeps nothing of what it wrote, and searches nothing at commit', () => {
    const rule = new RedactionRule({ keys: ['profile'] });
    const ctx = frame(rule, { profile: { name: 'Ada' } });
    const findPlanted = vi.spyOn(SelectedObjects.prototype, 'findPlanted');
    const noteShown = vi.spyOn(SelectedObjects.prototype, 'noteShown');
    ctx.setObject([], 'box', { x: 1 });
    ctx.commit();
    expect(findPlanted).not.toHaveBeenCalled();
    expect(noteShown).not.toHaveBeenCalled();
  });
});

describe('the search at commit — it finds what was put in after the write', () => {
  /** A frame over `state`, its rule and its log. */
  function begin(policy: ConstructorParameters<typeof RedactionRule>[0], state: Record<string, unknown>) {
    const rule = new RedactionRule(policy);
    const heap = new SharedMemory(undefined, state);
    const log = new EventLog(heap.getState());
    const ctx = new StageContext('', 's', 's', heap, '', log);
    ctx.useRedactionRule(rule);
    const last = () => log.recorded().at(-1) as { trace: { path: string; verb: string }[] };
    return { rule, ctx, log, last };
  }

  it.each([
    ['one field of it set', (ctx: StageContext) => ctx.updateObject([], 'profile', { visits: 2 })],
    [
      'all of it written back as a new record',
      (ctx: StageContext) => ctx.setObject([], 'profile', { name: 'Ada', inner: { pin: 1 } }),
    ],
  ])('a hidden key the frame itself wrote (%s) is followed when read back and put in place', (_how, write) => {
    // Once a frame writes a key, what it reads back are new objects. They hold the hidden content all the same.
    const { rule, ctx, last } = begin({ keys: ['profile'] }, { profile: { name: 'Ada', inner: { pin: 1 } } });
    ctx.getValue([], 'profile');
    write(ctx);
    const box: Record<string, unknown> = { x: 1 };
    ctx.setObject([], 'box', box);
    box.p = (ctx.getValue([], 'profile') as { inner: object }).inner; // in place, after the write
    ctx.commit();
    expect(rule.verdict(['box'])).toEqual({ kind: 'fields', key: 'box', paths: ['p'] });
    expect(JSON.stringify(last())).not.toContain('pin');
  });

  it('the first hidden read notes what the keys written before it show', () => {
    // `hist` was written before anything hidden was read, so no search ever walked it. The object in it
    // is hidden later and read back: it stays shown where the frame itself had put it.
    const { rule, ctx } = begin({ keys: ['b'] }, {});
    const noteShown = vi.spyOn(SelectedObjects.prototype, 'noteShown');
    const shared = { note: 'public' };
    ctx.setObject([], 'hist', { held: shared });
    ctx.setObject([], 'b', shared);
    expect(noteShown).not.toHaveBeenCalled();
    ctx.getValue([], 'b');
    expect(noteShown).toHaveBeenCalledTimes(2); // `hist`, and `b` (whose name hides all of it)
    ctx.commit();
    expect(rule.verdict(['hist'])).toBe(CLEAR);
  });

  it('put into ANOTHER key afterwards, the same object is found there', () => {
    const { rule, ctx } = begin({ keys: ['b'] }, {});
    const shared = { note: 'public' };
    ctx.setObject([], 'hist', { held: shared });
    ctx.setObject([], 'b', shared);
    const box: Record<string, unknown> = {};
    ctx.setObject([], 'box', box);
    box.p = ctx.getValue([], 'b'); // read back under the hidden name, then put in place
    ctx.commit();
    expect(rule.verdict(['hist'])).toBe(CLEAR); // where the frame wrote it before it was hidden
    expect(rule.verdict(['box'])).toEqual({ kind: 'fields', key: 'box', paths: ['p'] });
  });

  it('the containers a merge makes count as written: copied under a hidden name and read back, they stay shown', () => {
    const { rule, ctx, last } = begin({ keys: ['secret', 'hidden'] }, { secret: { token: 't' }, a: { x: { y: 1 } } });
    ctx.getValue([], 'secret'); // from here on every write is searched
    ctx.updateObject([], 'a', { x: { n: 1 } }); // the record builds a new `a` and a new `a.x`
    const made = (ctx.getValue([], 'a') as { x: object }).x;
    ctx.setObject([], 'hidden', made);
    ctx.getValue([], 'hidden');
    ctx.commit();
    expect(rule.verdict(['a'])).toBe(CLEAR);
    expect(
      last()
        .trace.filter((row) => row.path === 'a')
        .map((row) => row.verb),
    ).toEqual(['merge']);
  });

  it.each([
    [
      'a list the policy names by index',
      { fields: { profile: ['items.0.ssn'] } },
      { items: [{ ssn: '1', name: 'n' }] },
    ],
    ['one object at a hidden and a public place', { fields: { profile: ['ssn'] } }, sharedTwice()],
  ])('a key that is read and then merged into changes nothing else: %s', (_what, policy, profile) => {
    // A read after the frame's first write hands out a private copy. Every part of it is a new object,
    // and nothing was put in: the row stays the merge it was, and no place is added to the key's rule.
    const { rule, ctx, last } = begin(policy, { profile });
    ctx.setObject([], 'z', 1);
    ctx.getValue([], 'profile');
    ctx.updateObject([], 'profile', { n: 2 });
    ctx.commit();
    expect(rule.marksForCheckpoint()).toBeUndefined();
    expect(
      last()
        .trace.filter((row) => row.path === 'profile')
        .map((row) => row.verb),
    ).toEqual(['merge']);
  });

  it('a find that hides the whole key marks it, so a later frame reads it as hidden', () => {
    const { rule, ctx } = begin({ keys: ['profile'] }, { profile: { name: 'Ada' } });
    const profile = ctx.getValue([], 'profile');
    const list: unknown[] = [];
    ctx.setObject([], 'list', list);
    list.push(profile); // a list that holds a hidden object is hidden whole
    ctx.commit();
    expect(rule.verdict(['list'])).toEqual({ kind: 'whole', key: 'list' });
    expect(rule.marksForCheckpoint()?.keys).toContain('list');
  });

  it('a discarded try leaves nothing of what it wrote: what a key showed then does not count', () => {
    // Try 1 writes `own` under a public key while it is not hidden, and is thrown away. Try 2 hides the
    // same object, reads it back, changes that key and puts the object into it in place. What try 1
    // wrote was never written, so `own` was never shown there.
    const { rule, ctx, last } = begin({ keys: ['profile', 'hidden'] }, { profile: { name: 'Ada' }, box: { x: 1 } });
    const own = { pin: 1 };
    ctx.getValue([], 'profile');
    ctx.setObject([], 'box', { p: own });
    ctx.discardStaged();
    ctx.setObject([], 'hidden', own);
    const back = ctx.getValue([], 'hidden');
    ctx.updateObject([], 'box', { y: 2 }); // a change below the key: what it showed before would still count
    (ctx.getValue([], 'box') as Record<string, unknown>).p = back;
    ctx.commit();
    expect(rule.verdict(['box'])).toEqual({ kind: 'fields', key: 'box', paths: ['p'] });
    expect(JSON.stringify(last())).not.toContain('pin');
  });

  it('content the library cannot read is equal only to itself: a hidden record put in place of a public one of the same shape is found', () => {
    // Both hold one file. Two files cannot be compared, and the one put in is not a copy of the one
    // that was there: nothing may be assumed, so the place is hidden.
    const { rule, ctx } = begin(
      { keys: ['secret'] },
      { secret: { file: new Blob(['hidden']) }, box: { doc: { file: new Blob(['public']) } } },
    );
    ctx.setObject([], 'z', 1);
    const secret = ctx.getValue([], 'secret');
    ctx.updateObject([], 'box', { n: 1 });
    (ctx.getValue([], 'box') as Record<string, unknown>).doc = secret; // in place
    ctx.commit();
    expect(rule.verdict(['box'])).toEqual({ kind: 'fields', key: 'box', paths: ['doc'] });
  });

  it('a write BELOW a key adds to what the key showed: it does not start over', () => {
    // `own` sat in `box` when the frame wrote it. A later write of one path below `box` keeps the
    // rest of `box`, so `own` still counts as shown there after it is hidden.
    const { rule, ctx } = begin({ keys: ['profile', 'hidden'] }, { profile: { name: 'Ada' } });
    const own = { pin: 1 };
    ctx.getValue([], 'profile');
    ctx.setObject([], 'box', { held: own, sub: { old: true } });
    ctx.setObject(['box'], 'sub', { fresh: true });
    ctx.setObject([], 'hidden', own);
    ctx.getValue([], 'hidden');
    ctx.commit();
    expect(rule.verdict(['box'])).toBe(CLEAR);
  });

  it('the first hidden read notes a key only where its name hides nothing: a member under a hidden field is not shown', () => {
    // `profile` is written before anything hidden is read, with the stage's own object under its
    // hidden field `contact`. Read back, that object is hidden. Put at a public place of the key in
    // place, it is found: it never sat at a public place.
    const { rule, ctx } = begin({ keys: ['secret'], fields: { profile: ['contact'] } }, { secret: { token: 't' } });
    const own = { email: 'a@x' };
    const profile: Record<string, unknown> = { name: 'Ada', contact: own };
    ctx.setObject([], 'profile', profile);
    ctx.getValue([], 'secret'); // the first hidden read: the keys written before it are noted
    ctx.getValue([], 'profile'); // `own` is remembered, as the member under the hidden field
    profile.copy = own;
    ctx.commit();
    const hidden = rule.verdict(['profile']) as { kind: string; paths: string[] };
    expect([...hidden.paths].sort()).toEqual(['contact', 'copy']);
  });

  it('what the frame KEEPS of a merge is the caller’s patch: a hidden object put into it later is hidden in the kept form, and no rule changes', () => {
    const { rule, ctx, last } = begin({ keys: ['profile'] }, { profile: { name: 'Ada' }, a: { x: 1 } });
    let kept: Record<string, { value: unknown; operation: string }> = {};
    ctx.setCommitObserver((mutations) => {
      kept = mutations;
    });
    const profile = ctx.getValue([], 'profile');
    const row: Record<string, unknown> = { n: 1 };
    ctx.updateObject([], 'a', { row });
    row.owner = profile; // the record copied the patch at the merge: this never lands
    ctx.commit();
    expect(kept.a).toEqual({ value: { row: { n: 1, owner: '[REDACTED]' } }, operation: 'update' });
    expect(rule.verdict(['a'])).toBe(CLEAR);
    expect(JSON.stringify(last())).not.toContain('Ada');
  });

  it('what the frame keeps of a write BELOW a key takes that key’s rule as the search left it', () => {
    const { ctx } = begin({ keys: ['profile'] }, { profile: { name: 'Ada' }, box: { x: 1 } });
    let kept: Record<string, { value: unknown; operation: string }> = {};
    ctx.setCommitObserver((mutations) => {
      kept = mutations;
    });
    const profile = ctx.getValue([], 'profile');
    const sub: Record<string, unknown> = { n: 1 };
    ctx.setObject(['box'], 'sub', sub);
    sub.owner = profile; // in place, after the write
    ctx.commit();
    expect(kept['box.sub']).toEqual({ value: { n: 1, owner: '[REDACTED]' }, operation: 'set' });
  });

  it('the stage’s input: an object under a selected name in it, at any depth, is followed; the input is never a selected read', () => {
    const { ctx } = begin({ keys: ['profile'], fields: { card: ['number'] } }, {});
    const input = {
      profile: { name: 'Ada' },
      order: { profile: { name: 'Bea' }, card: { number: { digits: '4242' }, owner: { name: 'Cy' } } },
      open: { note: 'n' },
      list: [{ profile: { name: 'Dee' } }],
    };
    ctx.noteInputRead(input);
    expect(ctx.selectedReads).toBe(0);
    expect(ctx.setObject([], 'a', { held: input.profile })).toEqual({ kind: 'fields', key: 'a', paths: ['held'] });
    expect(ctx.setObject([], 'b', { held: input.order.profile })).toEqual({
      kind: 'fields',
      key: 'b',
      paths: ['held'],
    });
    expect(ctx.setObject([], 'c', { held: input.order.card })).toEqual({
      kind: 'fields',
      key: 'c',
      paths: ['held.number'],
    });
    expect(ctx.setObject([], 'd', { held: input.list[0].profile })).toEqual({
      kind: 'fields',
      key: 'd',
      paths: ['held'],
    });
    expect(ctx.setObject([], 'e', { held: input.open })).toBe(CLEAR);
    expect(ctx.setObject([], 'f', { held: input.order.card.owner })).toBe(CLEAR);
  });

  it('an input the rule cannot serve is remembered whole: the safe side, and the read does not fail', () => {
    const { ctx } = begin({ keys: ['profile'] }, {});
    vi.spyOn(RedactionRule.prototype, 'retainBoundary').mockImplementation(() => {
      throw new Error('keys that cannot be read');
    });
    const input = { open: { note: 'n' } };
    expect(() => ctx.noteInputRead(input)).not.toThrow();
    expect(ctx.setObject([], 'a', { held: input.open })).toEqual({ kind: 'fields', key: 'a', paths: ['held'] });
  });

  it('a kept merge patch is searched with what its key showed: an object the frame wrote there before hiding it stays as the record has it', () => {
    // The tree must not hide what the log shows. `own` went into `pub` by a merge while it was not
    // hidden; it is hidden afterwards and read back. The record shows `pub.held`, and so does the kept patch.
    const { rule, ctx } = begin({ keys: ['profile', 'hidden'] }, { profile: { name: 'Ada' }, pub: { x: 1 } });
    let kept: Record<string, { value: unknown; operation: string }> = {};
    ctx.setCommitObserver((mutations) => {
      kept = mutations;
    });
    ctx.getValue([], 'profile');
    const own = { note: 'public' };
    ctx.updateObject([], 'pub', { held: own });
    ctx.setObject([], 'hidden', own);
    ctx.getValue([], 'hidden');
    ctx.commit();
    expect(rule.verdict(['pub'])).toBe(CLEAR);
    expect(kept.pub).toEqual({ value: { held: { note: 'public' } }, operation: 'update' });
  });

  it('a kept merge patch that is a list with a hidden object put into it later is kept hidden whole', () => {
    // A list cannot carry a field, so all of the kept patch is hidden. The record never took the item.
    const { rule, ctx } = begin({ keys: ['profile'] }, { profile: { name: 'Ada' }, list: [{ id: 1 }] });
    let kept: Record<string, { value: unknown; operation: string }> = {};
    ctx.setCommitObserver((mutations) => {
      kept = mutations;
    });
    const profile = ctx.getValue([], 'profile');
    const more: unknown[] = [{ id: 2 }];
    ctx.updateObject([], 'list', more);
    more.push(profile); // after the merge
    ctx.commit();
    expect(kept.list).toEqual({ value: '[REDACTED]', operation: 'update' });
    expect(rule.verdict(['list'])).toBe(CLEAR);
  });

  it('a key written whole again, with nothing of its old value kept, shows only what it holds now', () => {
    // `own` sat in `box` once. The stage replaced `box`, then hid `own`, read it back and put it into
    // the new `box` in place: it is not where the stage had written it, so it is found.
    const { rule, ctx } = begin({ keys: ['profile', 'hidden'] }, { profile: { name: 'Ada' } });
    const own = { pin: 1 };
    ctx.getValue([], 'profile');
    ctx.setObject([], 'box', { held: own });
    const next: Record<string, unknown> = { other: 1 };
    ctx.setObject([], 'box', next);
    ctx.setObject([], 'hidden', own);
    next.p = ctx.getValue([], 'hidden');
    ctx.commit();
    expect(rule.verdict(['box'])).toEqual({ kind: 'fields', key: 'box', paths: ['p'] });
  });
});

/** A record whose hidden field and one public field are the same object. */
function sharedTwice(): Record<string, unknown> {
  const shared = { v: 'visible-shared' };
  return { ssn: shared, backup: shared, n: 1 };
}
