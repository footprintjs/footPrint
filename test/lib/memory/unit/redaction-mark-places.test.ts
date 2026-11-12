/**
 * Where the value of a mark lives (`memory/markPlaces.ts · placeOf`; `memory/redaction.ts`:
 * `RedactionRule` · `mark` / `landed` / `unmark` / `giveBack` / `restoreMarks`, and `markStagedWrite`), unit.
 *
 * A mark is a name, and a run has more than one key of a name. A mark remembers each place a hidden
 * value under its name landed. THE LAW: a delete ends a mark only by taking away its last place; a
 * delete anywhere else changes nothing. A value still on its way holds a place of its own until it has
 * landed. A delete that does not land gives back what it took. The run-level proof, with the leaks
 * this closed, is `test/lib/engine/security/redaction-mark-ends-with-its-value.test.ts`.
 */
import { EventLog, SharedMemory } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import { pendingPlace, placeOf } from '../../../../src/lib/memory/markPlaces';
import { type ClearedMark, CLEAR, markStagedWrite, RedactionRule } from '../../../../src/lib/memory/redaction';
import { StageContext } from '../../../../src/lib/memory/StageContext';

const PARENT = placeOf({}, []);
const SUBFLOW = placeOf({}, []);

/** What a staged delete took away, in a test that says it took something. */
function took(cleared: ClearedMark | undefined): ClearedMark {
  if (cleared === undefined) throw new Error('the delete took nothing');
  return cleared;
}

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

    // A sub-flowchart deletes its own `copy`. It never held the value: nothing is taken.
    expect(rule.unmark('copy', SUBFLOW)).toBeUndefined();
    expect(rule.isKeyRedacted('copy')).toBe(true);

    // The parent deletes its `copy`: the last place, so the mark ends.
    expect(rule.unmark('copy', PARENT)).toEqual({ key: 'copy', marked: true, place: PARENT });
    expect(rule.isKeyRedacted('copy')).toBe(false);
  });

  it('a name hidden in two places stays marked until both are gone', () => {
    const rule = new RedactionRule();
    rule.mark('copy', PARENT);
    rule.mark('copy', SUBFLOW);
    // What comes back says what the name HAD (it was marked), not whether this delete ended the mark.
    expect(rule.unmark('copy', SUBFLOW)).toEqual({ key: 'copy', marked: true, place: SUBFLOW });
    expect(rule.isKeyRedacted('copy')).toBe(true);
    expect(rule.unmark('copy', PARENT)).toEqual({ key: 'copy', marked: true, place: PARENT });
    expect(rule.isKeyRedacted('copy')).toBe(false);
  });

  it('a delete where no value of the name landed changes nothing: the value may still be on its way', () => {
    const rule = new RedactionRule();
    rule.mark('pin'); // decided hidden; nothing has landed anywhere yet
    expect(rule.unmark('pin', PARENT)).toBeUndefined();
    expect(rule.isKeyRedacted('pin')).toBe(true);
    // Only an unmark that does not say where ends such a mark.
    expect(rule.unmark('pin')).toEqual({ key: 'pin', marked: true });
    expect(rule.isKeyRedacted('pin')).toBe(false);
  });

  it('a value on its way holds a place of its own until whoever decided it lets go', () => {
    const rule = new RedactionRule();
    const onItsWay = pendingPlace();
    expect(pendingPlace()).not.toBe(onItsWay); // one for each asker
    rule.mark('item', onItsWay);

    // One value landed and was deleted again. Others are still to land: the mark stays.
    rule.landed('item', PARENT);
    expect(rule.unmark('item', PARENT)).toEqual({ key: 'item', marked: true, place: PARENT });
    expect(rule.isKeyRedacted('item')).toBe(true);

    // The next one lands. Then the asker lets go: the mark stays, held by the key that has the value.
    rule.landed('item', SUBFLOW);
    expect(rule.unmark('item', onItsWay)).toEqual({ key: 'item', marked: true, place: onItsWay });
    expect(rule.isKeyRedacted('item')).toBe(true);
    expect(rule.unmark('item', SUBFLOW)).toEqual({ key: 'item', marked: true, place: SUBFLOW });
    expect(rule.isKeyRedacted('item')).toBe(false);
  });

  it('letting go of a value that never landed ends the mark: nothing holds it', () => {
    const rule = new RedactionRule();
    const onItsWay = pendingPlace();
    rule.mark('item', onItsWay);
    expect(rule.unmark('item', onItsWay)).toEqual({ key: 'item', marked: true, place: onItsWay });
    expect(rule.isKeyRedacted('item')).toBe(false);
  });

  it('an unmark that does not say where ends the mark, whatever places it has', () => {
    const rule = new RedactionRule();
    rule.mark('copy', PARENT);
    rule.mark('copy', SUBFLOW);
    expect(rule.unmark('copy')).toEqual({ key: 'copy', marked: true });
    expect(rule.isKeyRedacted('copy')).toBe(false);
    // And the places went with it: a new mark of that name starts with none, so PARENT is not one.
    rule.mark('copy');
    expect(rule.unmark('copy', PARENT)).toBeUndefined();
    expect(rule.isKeyRedacted('copy')).toBe(true);
  });

  it('nothing to end is nothing taken', () => {
    const rule = new RedactionRule({ keys: ['ssn'] });
    expect(rule.unmark('never', PARENT)).toBeUndefined();
    // The policy's own keys are not marks: no delete ends them, and no place is kept for them.
    rule.landed('ssn', PARENT);
    expect(rule.unmark('ssn', PARENT)).toBeUndefined();
    expect(rule.verdict(['ssn'])).toEqual({ kind: 'whole', key: 'ssn' });
  });

  it('giveBack undoes a delete that did not land: the mark, and its place', () => {
    const rule = new RedactionRule();
    rule.mark('copy', PARENT);
    const taken = took(rule.unmark('copy', PARENT));
    expect(rule.isKeyRedacted('copy')).toBe(false);

    rule.giveBack(taken);
    expect(rule.isKeyRedacted('copy')).toBe(true);
    // The place is back too: a delete elsewhere still does not end the mark.
    expect(rule.unmark('copy', SUBFLOW)).toBeUndefined();
    expect(rule.isKeyRedacted('copy')).toBe(true);
  });

  it('giveBack restores a mark that ended somewhere else while the delete was only staged', () => {
    const rule = new RedactionRule();
    rule.mark('copy', PARENT);
    rule.mark('copy', SUBFLOW);
    const staged = took(rule.unmark('copy', PARENT)); // a try stages the parent's delete; the sub-flowchart still holds one
    rule.unmark('copy', SUBFLOW); // meanwhile the sub-flowchart really deletes its own: the last place, the mark ends
    expect(rule.isKeyRedacted('copy')).toBe(false);

    rule.giveBack(staged); // the try is thrown away: the parent's value is still there
    expect(rule.isKeyRedacted('copy')).toBe(true);
    expect(rule.unmark('copy', PARENT)).toEqual({ key: 'copy', marked: true, place: PARENT });
  });

  it('fields a mapper handed a key follow the same rule', () => {
    const rule = new RedactionRule();
    rule.inheritFields('person', ['email']);
    rule.landed('person', PARENT);
    expect(rule.verdict(['person'])).toEqual({ kind: 'fields', key: 'person', paths: ['email'] });

    expect(rule.unmark('person', SUBFLOW)).toBeUndefined();
    expect(rule.verdict(['person'])).toEqual({ kind: 'fields', key: 'person', paths: ['email'] });

    const taken = took(rule.unmark('person', PARENT));
    expect(taken).toEqual({ key: 'person', marked: false, place: PARENT, fields: ['email'] });
    expect(rule.verdict(['person'])).toBe(CLEAR);

    rule.giveBack(taken);
    expect(rule.verdict(['person'])).toEqual({ kind: 'fields', key: 'person', paths: ['email'] });
  });

  it('a mark carried over a pause stays: no delete can name the place its value is in', () => {
    const rule = new RedactionRule();
    rule.restoreMarks({ keys: ['copy'], fields: { person: ['email'] } });
    expect(rule.unmark('copy', PARENT)).toBeUndefined();
    expect(rule.unmark('person', PARENT)).toBeUndefined();
    expect(rule.isKeyRedacted('copy')).toBe(true);
    expect(rule.verdict(['person'])).toEqual({ kind: 'fields', key: 'person', paths: ['email'] });
    // It still travels to the next pause as a name.
    expect(rule.marksForCheckpoint()).toEqual({ keys: ['copy'], fields: { person: ['email'] } });
  });

  it('two rules that share one set of marked names share its places', () => {
    const shared = new Set<string>();
    const first = new RedactionRule(undefined, shared);
    const second = new RedactionRule(undefined, shared);
    first.mark('copy', PARENT);
    expect(second.unmark('copy', SUBFLOW)).toBeUndefined();
    expect(first.isKeyRedacted('copy')).toBe(true);
    expect(second.unmark('copy', PARENT)).toEqual({ key: 'copy', marked: true, place: PARENT });
    expect(first.isKeyRedacted('copy')).toBe(false);
  });
});

describe('markStagedWrite — with the place the write lands at', () => {
  it('a whole verdict marks its key at the place; a delete elsewhere takes nothing; the delete there ends it', () => {
    const rule = new RedactionRule();
    expect(markStagedWrite(rule, rule, { kind: 'whole', key: 'pin' }, [], 'pin', 'set', PARENT)).toBeUndefined();
    expect(rule.isKeyRedacted('pin')).toBe(true);
    expect(markStagedWrite(rule, rule, { kind: 'whole', key: 'pin' }, [], 'pin', 'delete', SUBFLOW)).toBeUndefined();
    expect(rule.isKeyRedacted('pin')).toBe(true);
    expect(markStagedWrite(rule, rule, { kind: 'whole', key: 'pin' }, [], 'pin', 'delete', PARENT)).toEqual({
      key: 'pin',
      marked: true,
      place: PARENT,
    });
    expect(rule.isKeyRedacted('pin')).toBe(false);
  });

  it('a fields verdict notes the place of fields a mapper handed the key, and none for the policy’s own', () => {
    const rule = new RedactionRule({ fields: { card: ['number'] } });
    rule.inheritFields('person', ['email']);
    markStagedWrite(rule, rule, { kind: 'fields', key: 'person', paths: ['email'] }, [], 'person', 'set', PARENT);
    markStagedWrite(rule, rule, { kind: 'fields', key: 'card', paths: ['number'] }, [], 'card', 'set', PARENT);
    // The handed fields have a place now, so a delete elsewhere leaves them.
    expect(rule.unmark('person', SUBFLOW)).toBeUndefined();
    expect(rule.verdict(['person'])).toEqual({ kind: 'fields', key: 'person', paths: ['email'] });
    // The policy's fields were never the rule's to end.
    expect(rule.unmark('card', PARENT)).toBeUndefined();
    expect(rule.verdict(['card'])).toEqual({ kind: 'fields', key: 'card', paths: ['number'] });
  });
});

describe('the frame — a staged delete that does not land gives back what it took', () => {
  function frame(rule: RedactionRule, state?: Record<string, unknown>) {
    const heap = new SharedMemory(undefined, state);
    const log = new EventLog(heap.getState());
    const ctx = new StageContext('', 's', 's', heap, '', log);
    ctx.useRedactionRule(rule);
    return { ctx, heap, log };
  }

  it('a delete in a frame whose staged writes are discarded (a retried try)', () => {
    const rule = new RedactionRule();
    const { ctx } = frame(rule);
    ctx.setObject([], 'pin', '0000', true);
    ctx.commit();

    ctx.setObject([], 'pin', undefined, false, undefined, 'delete');
    expect(rule.isKeyRedacted('pin')).toBe(false); // staged: within the try, the key reads as gone
    ctx.discardStaged();
    expect(rule.isKeyRedacted('pin')).toBe(true); // the try was thrown away: the key is still there
    // And its place is back: the delete of another frame, elsewhere, still does not end the mark.
    const elsewhere = frame(rule);
    elsewhere.ctx.setObject([], 'pin', undefined, false, undefined, 'delete');
    expect(rule.isKeyRedacted('pin')).toBe(true);
  });

  it('a delete in a frame whose commit fails', () => {
    const rule = new RedactionRule();
    const { ctx } = frame(rule);
    ctx.setObject([], 'pin', '0000', true);
    ctx.commit();

    ctx.setObject([], 'pin', undefined, false, undefined, 'delete');
    ctx.setObject([], 'bad', () => 1); // nothing can copy a function: the commit fails, and nothing lands
    expect(() => ctx.commit()).toThrow();
    expect(rule.isKeyRedacted('pin')).toBe(true);
  });

  it('a delete that lands ends the mark, and stays ended', () => {
    const rule = new RedactionRule();
    const { ctx } = frame(rule);
    ctx.setObject([], 'pin', '0000', true);
    ctx.commit();

    ctx.setObject([], 'pin', undefined, false, undefined, 'delete');
    ctx.commit();
    expect(rule.isKeyRedacted('pin')).toBe(false);
    ctx.discardStaged(); // nothing staged any more: nothing to give back
    expect(rule.isKeyRedacted('pin')).toBe(false);
  });

  it('fields a mapper handed a key: a write of any field under the key is a landing, and the delete there ends them', () => {
    const rule = new RedactionRule();
    rule.inheritFields('person', ['email']); // what a mapper's copy of a record with a hidden field does
    const { ctx } = frame(rule);
    // A sub-flowchart seed writes an object field by field. Most fields are clear.
    ctx.setObject(['person'], 'name', 'Ann');
    ctx.commit();

    const elsewhere = frame(rule);
    elsewhere.ctx.setObject([], 'person', undefined, false, undefined, 'delete');
    elsewhere.ctx.commit();
    expect(rule.verdict(['person'])).toEqual({ kind: 'fields', key: 'person', paths: ['email'] });

    ctx.setObject([], 'person', undefined, false, undefined, 'delete');
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
    branch.setObject([], 'copy', undefined, false, undefined, 'delete');
    branch.commit();
    expect(rule.isKeyRedacted('copy')).toBe(true);

    // A frame that writes at the root deletes the root key: the last place, so the mark ends.
    root.setObject([], 'copy', undefined, false, undefined, 'delete');
    root.commit();
    expect(rule.isKeyRedacted('copy')).toBe(false);
  });

  it('two frames over two states: the delete in one does not end the mark the other made', () => {
    const rule = new RedactionRule();
    const parent = frame(rule);
    const subflow = frame(rule);
    parent.ctx.setObject([], 'copy', ['secret'], true);
    parent.ctx.commit();

    subflow.ctx.setObject([], 'copy', undefined, false, undefined, 'delete');
    subflow.ctx.commit();
    expect(rule.isKeyRedacted('copy')).toBe(true);

    parent.ctx.setObject([], 'copy', undefined, false, undefined, 'delete');
    parent.ctx.commit();
    expect(rule.isKeyRedacted('copy')).toBe(false);
  });
});
