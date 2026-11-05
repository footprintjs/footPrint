/** AUTHOR DRAFT — UNRUN. Inert string ownership only; no product/native installer import. */
import { describe, expect, it } from 'vitest';

import type { PauseFieldCapture } from './index.js';
import { pauseLegViews } from './index.js';

function input(legs = 2, policy = false) {
  const out: Record<string, string> = {};
  const captures: PauseFieldCapture[] = [];
  const put = (leg: number, field: string) => {
    const value = `unchanged bytes:${field}:🚦\n`;
    out[field] = value;
    captures.push({ leg, field, value });
  };
  for (let leg = 0; leg < legs; leg++) {
    for (const suffix of ['log', 'state', 'init', 'sub', 'folds', ...(policy ? ['red', 'redsub'] : [])])
      put(leg, `leg${leg}.${suffix}`);
    if (leg + 1 < legs) {
      put(leg, `cp${leg + 1}`);
      put(leg, `cp${leg + 1}.tree`);
    }
  }
  for (const field of ['runError', 'errors', 'pauses']) put(legs - 1, field);
  return { out, captures, legs, policy };
}
const view = (f: ReturnType<typeof input>) => pauseLegViews(f.out, f.captures, f.legs, f.policy);

describe('actual pause leg field views', () => {
  it.each([false, true])('covers each physical field exactly once, reversibly, with policy=%s', (policy) => {
    const f = input(3, policy);
    const before = JSON.stringify(f.out);
    const views = view(f);
    expect(views).toHaveLength(3);
    const restored: Record<string, string> = {};
    for (const leg of views) {
      expect(Object.keys(leg.kept)).toEqual(Object.keys(leg.physicalByLogical));
      for (const [logical, text] of Object.entries(leg.kept)) {
        const physical = leg.physicalByLogical[logical];
        expect(Object.hasOwn(restored, physical)).toBe(false);
        expect(text).toBe(f.out[physical]);
        restored[physical] = text;
      }
      expect(Object.isFrozen(leg)).toBe(true);
      expect(Object.isFrozen(leg.kept)).toBe(true);
      expect(Object.isFrozen(leg.physicalByLogical)).toBe(true);
    }
    expect(restored).toEqual(f.out);
    expect(JSON.stringify(f.out)).toBe(before);
    expect(views[0].kept.cp1).toBe(f.out.cp1);
    expect(views[0].kept['cp1.tree']).toBe(f.out['cp1.tree']);
    expect(views[1].kept.cp2).toBe(f.out.cp2);
    expect(views[1].kept['cp2.tree']).toBe(f.out['cp2.tree']);
    expect(Object.hasOwn(views[1].kept, 'cp1.tree')).toBe(false);
    expect(views[2].kept.runError).toBe(f.out.runError);
    expect(views.slice(0, 2).every((leg) => !Object.hasOwn(leg.kept, 'runError'))).toBe(true);
  });

  it('renames only subflow field names; all string bytes and physical names stay exact', () => {
    const f = input(2, true);
    const views = view(f);
    for (const [i, leg] of views.entries()) {
      expect(leg.kept.subflowResults).toBe(f.out[`leg${i}.sub`]);
      expect(leg.physicalByLogical.subflowResults).toBe(`leg${i}.sub`);
      expect(leg.kept.redactedSubflows).toBe(f.out[`leg${i}.redsub`]);
      expect(leg.physicalByLogical.redactedSubflows).toBe(`leg${i}.redsub`);
      expect(leg.kept[`leg${i}.state`]).toBe(f.out[`leg${i}.state`]);
    }
  });

  it('one direct actual leg owns globals and has no checkpoint', () => {
    const f = input(1);
    const [only] = view(f);
    expect(only.kept.pauses).toBe(f.out.pauses);
    expect(Object.keys(only.kept).some((field) => /^cp/.test(field))).toBe(false);
  });

  it('refuses a duplicated capture even with identical owner and bytes', () => {
    const f = input();
    f.captures.push(f.captures[0]);
    expect(() => view(f)).toThrow('extra, duplicate or wrong-leg capture');
  });

  it('refuses a missing ownership record', () => {
    const f = input();
    f.captures.pop();
    expect(() => view(f)).toThrow('output field has no actual capture owner');
  });

  it.each(['cp1', 'cp1.tree', 'leg0.state', 'runError', 'errors', 'pauses'])(
    'refuses wrong-leg ownership for %s',
    (field) => {
      const f = input();
      f.captures = f.captures.map((capture) =>
        capture.field !== field ? capture : { ...capture, leg: 1 - capture.leg },
      );
      expect(() => view(f)).toThrow('extra, duplicate or wrong-leg capture');
    },
  );

  it('refuses output added after capture instead of hiding an unrelated future error', () => {
    const f = input();
    f.out.unexpectedFutureError = 'independent corruption';
    expect(() => view(f)).toThrow('missing or extra output field');
  });

  it('refuses missing actual output even when a captured string remains', () => {
    const f = input();
    delete f.out['cp1.tree'];
    expect(() => view(f)).toThrow('missing or extra output field');
  });

  it('refuses changed bytes after capture instead of projecting them away', () => {
    const f = input();
    f.out.errors = 'independent corruption';
    expect(() => view(f)).toThrow('capture bytes do not match actual output');
  });

  it('does not execute an accessor while validating exact captured output', () => {
    const f = input();
    let reads = 0;
    Object.defineProperty(f.out, 'errors', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 'hidden';
      },
    });
    expect(() => view(f)).toThrow('missing own-data field');
    expect(reads).toBe(0);
  });

  it('refuses an unpaired redaction field and an output from a different policy shape', () => {
    const f = input(2, true);
    delete f.out['leg0.redsub'];
    expect(() => view(f)).toThrow('missing or extra output field');
    expect(() => pauseLegViews(input(2, true).out, input(2, true).captures, 2, false)).toThrow(
      'missing or extra output field',
    );
  });

  it.each([0, 22, -1, 1.5, Infinity, NaN])('refuses leg count %s outside the existing finite drive', (legs) => {
    const f = input();
    expect(() => pauseLegViews(f.out, f.captures, legs, false)).toThrow('existing drive bounds');
  });
});
