/**
 * Where the value of a mark lives, and when a mark ends (`memory/markPlaces.ts`; `memory/redaction.ts`:
 * `RedactionRule` · `mark` / `landed` / `unmark` / `restoreMarks`, and `markStagedWrite`; the frame:
 * `StageContext · endMarksOfLandedDeletes`), unit.
 *
 * A mark is a name, and a run has more than one key of a name. A mark remembers each place a hidden
 * value under its name landed. THE LAW: a delete ends a mark only by taking away its last place; a
 * delete anywhere else changes nothing. A value still on its way holds a place of its own until it has
 * landed. And a delete ends nothing while it is only staged: the frame asks the state once its commit
 * has landed, and ends the mark when the key is really gone. The run-level proof, with the leaks this
 * closed, is `test/lib/engine/security/redaction-mark-ends-with-its-value.test.ts`.
 */
import { EventLog, SharedMemory } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import { pendingPlace, placeOf } from '../../../../src/lib/memory/markPlaces';
import { CLEAR, markStagedWrite, RedactionRule } from '../../../../src/lib/memory/redaction';
import { StageContext } from '../../../../src/lib/memory/StageContext';

const PARENT = placeOf({}, []);
const SUBFLOW = placeOf({}, []);

describe('placeOf — a state and an address under it', () => {
  it('is the same for the same state and address, and differs when either does', () => {
    const state = {};
    const other = {};
    expect(placeOf(state, [])).toBe(placeOf(state, []));
    expect(placeOf(state, ['runs', 'a'])).toBe(placeOf(state, ['runs', 'a']));
    expect(placeOf(state, [])).not.toBe(placeOf(other, []));
    expect(placeOf(state, [])).not.toBe(placeOf(state, ['runs', 'a']));
    expect(placeOf(state, ['runs', 'a'])).not.toBe(placeOf(state, ['runs', 'b']));
  });
});

describe('RedactionRule — a mark ends with its last place', () => {
  it('a delete somewhere else does not end a mark; the delete where the value lives does', () => {
    const rule = new RedactionRule();
    rule.mark('copy', PARENT);

    // A sub-flowchart deleted its own `copy`. It never held the value: nothing changes.
    rule.unmark('copy', SUBFLOW);
    expect(rule.isKeyRedacted('copy')).toBe(true);

    // The parent deleted its `copy`: the last place, so the mark ends.
    rule.unmark('copy', PARENT);
    expect(rule.isKeyRedacted('copy')).toBe(false);
  });

  it('a name hidden in two places stays marked until both are gone', () => {
    const rule = new RedactionRule();
    rule.mark('copy', PARENT);
    rule.mark('copy', SUBFLOW);
    rule.unmark('copy', SUBFLOW);
    expect(rule.isKeyRedacted('copy')).toBe(true);
    rule.unmark('copy', SUBFLOW); // the same place again: it is gone already, nothing changes
    expect(rule.isKeyRedacted('copy')).toBe(true);
    rule.unmark('copy', PARENT);
    expect(rule.isKeyRedacted('copy')).toBe(false);
  });

  it('a delete where no value of the name landed changes nothing: the value may still be on its way', () => {
    const rule = new RedactionRule();
    rule.mark('pin'); // decided hidden; nothing has landed anywhere yet
    rule.unmark('pin', PARENT);
    expect(rule.isKeyRedacted('pin')).toBe(true);
    // Only an unmark that does not say where ends such a mark.
    rule.unmark('pin');
    expect(rule.isKeyRedacted('pin')).toBe(false);
  });

  it('a value on its way holds a place of its own until whoever decided it lets go', () => {
    const rule = new RedactionRule();
    const onItsWay = pendingPlace();
    expect(pendingPlace()).not.toBe(onItsWay); // one for each asker
    rule.mark('item', onItsWay);

    // One value landed and was deleted again. Others are still to land: the mark stays.
    rule.landed('item', PARENT);
    rule.unmark('item', PARENT);
    expect(rule.isKeyRedacted('item')).toBe(true);

    // The next one lands. Then the asker lets go: the mark stays, held by the key that has the value.
    rule.landed('item', SUBFLOW);
    rule.unmark('item', onItsWay);
    expect(rule.isKeyRedacted('item')).toBe(true);
    rule.unmark('item', SUBFLOW);
    expect(rule.isKeyRedacted('item')).toBe(false);
  });

  it('letting go of a value that never landed ends the mark: nothing holds it', () => {
    const rule = new RedactionRule();
    const onItsWay = pendingPlace();
    rule.mark('item', onItsWay);
    rule.unmark('item', onItsWay);
    expect(rule.isKeyRedacted('item')).toBe(false);
  });

  it('an unmark that does not say where ends the mark, whatever places it has', () => {
    const rule = new RedactionRule();
    rule.mark('copy', PARENT);
    rule.mark('copy', SUBFLOW);
    rule.unmark('copy');
    expect(rule.isKeyRedacted('copy')).toBe(false);
    // And the places went with it: a new mark of that name starts with none, so PARENT is not one.
    rule.mark('copy');
    rule.unmark('copy', PARENT);
    expect(rule.isKeyRedacted('copy')).toBe(true);
  });

  it('what the policy itself names is not a mark: no place is kept for it, and no delete ends it', () => {
    const rule = new RedactionRule({ keys: ['ssn'] });
    expect(rule.keeps('ssn')).toBe(false);
    rule.landed('ssn', PARENT);
    rule.unmark('ssn', PARENT);
    rule.unmark('ssn');
    expect(rule.verdict(['ssn'])).toEqual({ kind: 'whole', key: 'ssn' });
  });

  it('fields a mapper handed a key follow the same rule', () => {
    const rule = new RedactionRule();
    rule.inheritFields('person', ['email']);
    expect(rule.keeps('person')).toBe(true);
    rule.landed('person', PARENT);
    expect(rule.verdict(['person'])).toEqual({ kind: 'fields', key: 'person', paths: ['email'] });

    rule.unmark('person', SUBFLOW);
    expect(rule.verdict(['person'])).toEqual({ kind: 'fields', key: 'person', paths: ['email'] });

    rule.unmark('person', PARENT);
    expect(rule.verdict(['person'])).toBe(CLEAR);
    expect(rule.keeps('person')).toBe(false);
  });

  it('a mark carried over a pause stays: no delete can name the place its value is in', () => {
    const rule = new RedactionRule();
    rule.restoreMarks({ keys: ['copy'], fields: { person: ['email'] } });
    rule.unmark('copy', PARENT);
    rule.unmark('person', PARENT);
    expect(rule.isKeyRedacted('copy')).toBe(true);
    expect(rule.verdict(['person'])).toEqual({ kind: 'fields', key: 'person', paths: ['email'] });
    // It still travels to the next pause as a name.
    expect(rule.marksForCheckpoint()).toEqual({ keys: ['copy'], fields: { person: ['email'] } });
  });

  it('a mark carried over a pause stays even when the resumed run writes the name again and deletes it', () => {
    // The value from before the pause may live anywhere (a sub-flowchart's state, say). The resumed
    // run's own key is one more place, and its delete takes away that one only.
    const rule = new RedactionRule();
    rule.restoreMarks({ keys: ['copy'], fields: { person: ['email'] } });
    rule.mark('copy', PARENT);
    rule.landed('person', PARENT);
    rule.unmark('copy', PARENT);
    rule.unmark('person', PARENT);
    expect(rule.isKeyRedacted('copy')).toBe(true);
    expect(rule.verdict(['person'])).toEqual({ kind: 'fields', key: 'person', paths: ['email'] });
  });

  it('two rules that share one set of marked names share its places', () => {
    const shared = new Set<string>();
    const first = new RedactionRule(undefined, shared);
    const second = new RedactionRule(undefined, shared);
    first.mark('copy', PARENT);
    second.unmark('copy', SUBFLOW);
    expect(first.isKeyRedacted('copy')).toBe(true);
    second.unmark('copy', PARENT);
    expect(first.isKeyRedacted('copy')).toBe(false);
  });
});

describe('markStagedWrite — with the place the write lands at', () => {
  it('a whole verdict marks its key at the place', () => {
    const rule = new RedactionRule();
    expect(markStagedWrite(rule, rule, { kind: 'whole', key: 'pin' }, [], 'pin', 'set', PARENT)).toBeUndefined();
    expect(rule.isKeyRedacted('pin')).toBe(true);
    rule.unmark('pin', SUBFLOW); // not its place
    expect(rule.isKeyRedacted('pin')).toBe(true);
    rule.unmark('pin', PARENT);
    expect(rule.isKeyRedacted('pin')).toBe(false);
  });

  it('a delete ends nothing when it is staged: it hands back its claim on the mark, for the frame to end later', () => {
    const rule = new RedactionRule();
    rule.mark('pin', PARENT);
    const claim = markStagedWrite(rule, rule, { kind: 'whole', key: 'pin' }, [], 'pin', 'delete', PARENT);
    expect(claim).toEqual({ rule, key: 'pin', place: PARENT });
    expect(rule.isKeyRedacted('pin')).toBe(true); // only staged
    // A nested delete names the dotted path, never the top key: `profile` keeps its mark.
    rule.mark('profile', PARENT);
    expect(
      markStagedWrite(rule, rule, { kind: 'whole', key: 'profile' }, ['profile'], 'auth', 'delete', PARENT),
    ).toBeUndefined();
  });

  it('a delete of a name the rule does not keep claims nothing, and so does a delete while no rule was active', () => {
    const rule = new RedactionRule({ keys: ['ssn'] });
    expect(markStagedWrite(rule, rule, CLEAR, [], 'other', 'delete', PARENT)).toBeUndefined();
    expect(markStagedWrite(rule, rule, { kind: 'whole', key: 'ssn' }, [], 'ssn', 'delete', PARENT)).toBeUndefined();
    const later = new RedactionRule();
    later.mark('box', PARENT);
    expect(markStagedWrite(undefined, later, CLEAR, [], 'box', 'delete', PARENT)).toBeUndefined();
  });

  it('a fields verdict notes the place of fields a mapper handed the key, and none for the policy’s own', () => {
    const rule = new RedactionRule({ fields: { card: ['number'] } });
    rule.inheritFields('person', ['email']);
    markStagedWrite(rule, rule, { kind: 'fields', key: 'person', paths: ['email'] }, [], 'person', 'set', PARENT);
    markStagedWrite(rule, rule, { kind: 'fields', key: 'card', paths: ['number'] }, [], 'card', 'set', PARENT);
    // The handed fields have a place now, so a delete elsewhere leaves them.
    rule.unmark('person', SUBFLOW);
    expect(rule.verdict(['person'])).toEqual({ kind: 'fields', key: 'person', paths: ['email'] });
    // The policy's fields were never the rule's to end.
    rule.unmark('card', PARENT);
    expect(rule.verdict(['card'])).toEqual({ kind: 'fields', key: 'card', paths: ['number'] });
  });
});

describe('the frame — a mark ends when the delete has landed and the key is gone', () => {
  function frame(rule: RedactionRule, state?: Record<string, unknown>) {
    const heap = new SharedMemory(undefined, state);
    const log = new EventLog(heap.getState());
    const ctx = new StageContext('', 's', 's', heap, '', log);
    ctx.useRedactionRule(rule);
    return { ctx, heap, log };
  }
  const deleteKey = (ctx: StageContext, key: string) => ctx.setObject([], key, undefined, false, undefined, 'delete');

  it('a staged delete ends nothing; the commit that lands it does', () => {
    const rule = new RedactionRule();
    const { ctx } = frame(rule);
    ctx.setObject([], 'pin', '0000', true);
    ctx.commit();

    deleteKey(ctx, 'pin');
    expect(rule.isKeyRedacted('pin')).toBe(true); // only staged
    ctx.commit();
    expect(rule.isKeyRedacted('pin')).toBe(false);
  });

  it('a delete in a frame whose staged writes are discarded (a retried try) ends nothing', () => {
    const rule = new RedactionRule();
    const { ctx } = frame(rule);
    ctx.setObject([], 'pin', '0000', true);
    ctx.commit();

    deleteKey(ctx, 'pin');
    ctx.discardStaged(); // the try was thrown away: the key is still there
    ctx.commit(); // the next try commits nothing about `pin`
    expect(rule.isKeyRedacted('pin')).toBe(true);
  });

  it('a delete in a frame whose commit fails ends nothing', () => {
    const rule = new RedactionRule();
    const { ctx, heap } = frame(rule);
    ctx.setObject([], 'pin', '0000', true);
    ctx.commit();

    deleteKey(ctx, 'pin');
    ctx.setObject([], 'bad', () => 1); // nothing can copy a function: the commit fails, and nothing lands
    expect(() => ctx.commit()).toThrow();
    expect(heap.getState().pin).toBe('0000');
    expect(rule.isKeyRedacted('pin')).toBe(true);
  });

  it('a stage that deletes a key and writes it again has not deleted it: the mark stays', () => {
    const rule = new RedactionRule();
    const { ctx, heap } = frame(rule);
    ctx.setObject([], 'pin', '0000', true);
    ctx.commit();

    const read = ctx.getValue([], 'pin') as string; // the hidden text, read first
    deleteKey(ctx, 'pin');
    ctx.setObject([], 'pin', read); // and written back: a text has no identity to follow
    ctx.commit();
    expect(heap.getState().pin).toBe('0000');
    expect(rule.isKeyRedacted('pin')).toBe(true);
  });

  it('fields a mapper handed a key: a write of any field under the key is a landing, and the delete there ends them', () => {
    const rule = new RedactionRule();
    rule.inheritFields('person', ['email']); // what a mapper's copy of a record with a hidden field does
    const { ctx } = frame(rule);
    // A sub-flowchart seed writes an object field by field. Most fields are clear.
    ctx.setObject(['person'], 'name', 'Ann');
    ctx.commit();

    const elsewhere = frame(rule);
    deleteKey(elsewhere.ctx, 'person');
    elsewhere.ctx.commit();
    expect(rule.verdict(['person'])).toEqual({ kind: 'fields', key: 'person', paths: ['email'] });

    deleteKey(ctx, 'person');
    ctx.commit();
    expect(rule.verdict(['person'])).toBe(CLEAR);
  });

  it('a root-level write of a namespaced frame lands at the root, and the root is its place', () => {
    const rule = new RedactionRule();
    rule.mark('copy'); // decided hidden (what a mapper's copy does); the write below lands it
    const heap = new SharedMemory();
    const log = new EventLog(heap.getState());
    const branch = new StageContext('b1', 'branch', 'branch', heap, 'b1', log); // writes under runs/b1
    branch.useRedactionRule(rule);
    const root = new StageContext('', 'root', 'root', heap, '', log);
    root.useRedactionRule(rule);

    branch.setGlobal('copy', ['secret']); // a mount's merge-back: the ROOT key, not runs/b1/copy
    branch.commit();
    expect(heap.getState().copy).toEqual(['secret']);

    // The branch deletes ITS OWN `copy` (runs/b1/copy). The value is not there: the mark stays.
    deleteKey(branch, 'copy');
    branch.commit();
    expect(rule.isKeyRedacted('copy')).toBe(true);

    // A frame that writes at the root deletes the root key: the last place, so the mark ends.
    deleteKey(root, 'copy');
    root.commit();
    expect(rule.isKeyRedacted('copy')).toBe(false);
  });

  it('two frames over two states: the delete in one does not end the mark the other made', () => {
    const rule = new RedactionRule();
    const parent = frame(rule);
    const subflow = frame(rule);
    parent.ctx.setObject([], 'copy', ['secret'], true);
    parent.ctx.commit();

    deleteKey(subflow.ctx, 'copy');
    subflow.ctx.commit();
    expect(rule.isKeyRedacted('copy')).toBe(true);

    deleteKey(parent.ctx, 'copy');
    parent.ctx.commit();
    expect(rule.isKeyRedacted('copy')).toBe(false);
  });
});
