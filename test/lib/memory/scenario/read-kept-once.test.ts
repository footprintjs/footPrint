/**
 * A read is kept once for each object a key holds (`memory/keptReads.ts`): the cases, one by one.
 *
 * The property beside this file (`../property/read-kept-once.property.test.ts`) holds the rule against
 * "retain at every read" over random programs on the typed scope. Here are the cases such a program
 * cannot reach (an engine write at a nested path, a key another frame replaced, a rule that comes into
 * force between two reads), what the rule saves, counted and not timed, and the one thing that moves.
 */
import { EventLog, SharedMemory } from 'foottrace/write';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { disableDevMode, enableDevMode, flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { RedactionRule } from '../../../../src/lib/memory/redaction';
import { runPolicy } from '../../../../src/lib/memory/runPolicy';
import { StageContext } from '../../../../src/lib/memory/StageContext';

type State = Record<string, any>;
const quiet = { info() {}, log() {}, debug() {}, error() {}, warn() {} };

/** A frame that reads and writes at the root, over `state`. */
function rootFrame(state: State, name = 'Stage') {
  const mem = new SharedMemory(state);
  const log = new EventLog(state);
  return { mem, log, frame: new StageContext('', name, name.toLowerCase(), mem, '', log) };
}
const readsOf = (frame: StageContext) => frame.getSnapshot().stageReads as State;
/** A read whose value the test does not use: the read itself is the point. */
const read = (_value: unknown): void => undefined;

describe('what it saves', () => {
  /** How often a value was copied while a chart ran: every copy the engine takes goes through here. */
  async function copiesDuring(run: () => Promise<unknown>, counted: (value: unknown) => boolean): Promise<number> {
    const real = globalThis.structuredClone;
    let copies = 0;
    const spy = vi.spyOn(globalThis, 'structuredClone').mockImplementation(((value: unknown, options?: never) => {
      if (counted(value)) copies += 1;
      return real(value, options);
    }) as typeof structuredClone);
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    return copies;
  }
  const walking = (length: number, readTracking?: string) => () => {
    const chart = flowChart<State>(
      'Seed',
      (s) => {
        s.items = Array.from({ length }, (_, id) => ({ id }));
      },
      'seed',
    )
      .addFunction(
        'Walk',
        (s) => {
          let sum = 0;
          for (let i = 0; i < length; i++) sum += s.items[i].id;
          s.sum = sum;
        },
        'walk',
      )
      .setLogger(quiet)
      .build();
    return new FlowChartExecutor(chart, readTracking ? ({ readTracking } as never) : undefined).run();
  };

  it('a list walked by index is copied the same number of times whatever its length', async () => {
    // Before: one copy of the whole list at every `s.items[i]`. 1,000 records took 226 ms, 3,000 took
    // 2.0 s (bench/repeat-reads.ts). Counted here, not timed: the count must not grow with the walk.
    const isList = (value: unknown) => Array.isArray(value);
    const short = await copiesDuring(walking(20), isList);
    const long = await copiesDuring(walking(400), isList);
    expect(long).toBe(short);
    expect(long).toBeLessThan(10);
  });

  it('a text is kept without a copy, however often it is read', async () => {
    // A text cannot be changed, so it is its own copy. Before, each read copied it: 1,000 reads of a
    // 1 MB text took 83 ms. (The record still copies a text once where it is written.)
    const reading = (times: number) => {
      const chart = flowChart<State>(
        'Seed',
        (s) => {
          s.text = 'x'.repeat(10_000);
        },
        'seed',
      )
        .addFunction(
          'Read',
          (s) => {
            let length = 0;
            for (let i = 0; i < times; i++) length += s.text.length;
            s.length = length;
          },
          'read',
        )
        .setLogger(quiet)
        .build();
      return new FlowChartExecutor(chart);
    };
    const isText = (value: unknown) => typeof value === 'string';
    const few = await copiesDuring(() => reading(2).run(), isText);
    const executor = reading(60);
    const many = await copiesDuring(() => executor.run(), isText);
    expect(many).toBe(few);
    expect((executor.getSnapshot().executionTree as State).next.stageReads.text).toBe('x'.repeat(10_000));
  });

  it("under 'summary' the marker of the first read stands for the next ones", () => {
    const { frame } = rootFrame({ wide: { a: 1, b: 2 } });
    frame.usePolicy(runPolicy({ readTracking: 'summary' }));
    frame.getValue([], 'wide');
    const first = readsOf(frame).wide;
    frame.getValue([], 'wide');
    expect(readsOf(frame).wide).toBe(first);
    expect(first).toEqual({ __readSummary: true, type: 'object', size: 2 });
  });

  it('holds none of the objects it read once the step has committed', () => {
    // What says "this object is already kept" points at a committed value. Held past the step it would
    // keep every generation a run reads alive.
    const { frame } = rootFrame({ box: { n: 1 } });
    frame.getValue([], 'box');
    const held = () => (frame as unknown as State).keptReads.byRoot as Map<string, unknown> | undefined;
    expect(held()?.size).toBe(1);
    frame.commit();
    expect(held()).toBeUndefined();
    expect(readsOf(frame)).toEqual({ box: { n: 1 } });
  });
});

describe('when a key is kept again', () => {
  it('after the step wrote it', () => {
    const { frame } = rootFrame({ box: { n: 1 } });
    frame.getValue([], 'box');
    frame.setObject([], 'box', { n: 2 });
    frame.getValue([], 'box');
    expect(readsOf(frame)).toEqual({ box: { n: 2 } });
  });

  it('after the step wrote UNDER it, at a nested path, every time', () => {
    // The engine writes this way (a subflow's merge-back). The first such write gives the frame its own
    // copy of the box; the second one edits that copy where it is, so the box is the same object and
    // holds something new. From its first write on, the root is kept at every read.
    const { frame } = rootFrame({ box: { list: [1], n: 1 } });
    frame.getValue([], 'box');
    frame.setObject(['box'], 'n', 2);
    frame.getValue([], 'box');
    expect(readsOf(frame).box).toEqual({ list: [1], n: 2 });
    frame.setObject(['box'], 'extra', true);
    frame.getValue([], 'box');
    expect(readsOf(frame).box).toEqual({ list: [1], n: 2, extra: true });
  });

  it('after the step MERGED under it, or deleted under it: every kind of write marks the root', () => {
    // Found by the second reader: a rule that marked the root only at a `set` passed every other test.
    // The first merge under `box` gives the frame its own copy of it; the second edits that copy where
    // it is. Without the mark, the third read would find "the same object" and keep what is now stale.
    const { frame } = rootFrame({ box: { f: { a: 1 }, g: { b: 1 } } });
    frame.getValue([], 'box');
    frame.merge(['box'], 'f', { a: 2 });
    const second = frame.getValue([], 'box');
    frame.merge(['box'], 'g', { b: 2 });
    expect(frame.getValue([], 'box')).toBe(second); // the same object, holding something new
    expect(readsOf(frame).box).toEqual({ f: { a: 2 }, g: { b: 2 } });
    frame.setObject(['box'], 'g', undefined);
    frame.getValue([], 'box');
    expect(readsOf(frame).box).toEqual({ f: { a: 2 } });
  });

  it('a read at a nested path is kept at every read', () => {
    // Only the engine reads at a path. Such a read is not held against a root's object at all: its key
    // is a path, and another root may bear the leaf's name.
    const { frame } = rootFrame({ list: ['root'], box: { list: ['a'] } });
    frame.getValue([], 'list');
    frame.getValue(['box'], 'list');
    frame.setObject(['box', 'list'], '1', 'b');
    frame.getValue(['box'], 'list');
    frame.setObject(['box', 'list'], '2', 'c');
    frame.getValue(['box'], 'list');
    expect(readsOf(frame)).toEqual({ list: ['root'], 'box.list': ['a', 'b', 'c'] });
  });

  it('a read at a path is kept even when a root key holds the very same object', () => {
    // Found by the second reader: state may hold one object in two places. The object kept for root
    // `b` says nothing about the slot of the path a → b, which has not been kept at all yet.
    const shared = { n: 1 };
    const { frame } = rootFrame({ a: { b: shared }, b: shared });
    const atRoot = frame.getValue([], 'b');
    expect(frame.getValue(['a'], 'b')).toBe(atRoot);
    expect(readsOf(frame)).toEqual({ b: { n: 1 }, 'a.b': { n: 1 } });
  });

  it('a root key with a dot in its name shares a slot with a path, and the last read of the slot wins', () => {
    // Found by the second reader. `'a.b'` is a root key, and also how the path a → b is spelled in
    // `stageReads`. The read at the path fills the slot, so the root's object no longer stands for it:
    // the root read after it must be kept again.
    const { frame } = rootFrame({ 'a.b': { root: true }, a: { b: { nested: true } } });
    frame.getValue([], 'a.b');
    frame.getValue(['a'], 'b');
    expect(readsOf(frame)).toEqual({ 'a.b': { nested: true } });
    frame.getValue([], 'a.b');
    expect(readsOf(frame)).toEqual({ 'a.b': { root: true } });
  });

  it('after the owner of an object the step wrote has changed it', async () => {
    // Allowed since 9.23.0: what a stage assigns is taken at commit, so `s.k = o; o.n = 1` commits n: 1,
    // and a read in between returns `o` as it is then. The same object, holding something new.
    const owned = { n: 0 };
    const chart = flowChart<State>(
      'Write',
      (s) => {
        s.box = owned;
        read(s.box.n);
        owned.n = 1;
        read(s.box.n);
      },
      'write',
    )
      .setLogger(quiet)
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect((executor.getSnapshot().executionTree as State).stageReads).toEqual({ box: { n: 1 } });
    expect(executor.getSnapshot().sharedState).toEqual({ box: { n: 1 } });
  });

  it('when another frame has replaced the key in between', () => {
    // A frame that writes under its own address reads a root key live. A neighbour's commit hands it a
    // new object under the same key: not the object that was kept, so it is kept anew.
    const state = { box: { v: 'first' } };
    const mem = new SharedMemory(state);
    const log = new EventLog(state);
    const branch = new StageContext('br', 'Branch', 'branch', mem, '', log);
    expect(branch.getValue([], 'box')).toEqual({ v: 'first' });
    const neighbour = new StageContext('', 'Neighbour', 'neighbour', mem, '', log);
    neighbour.setObject([], 'box', { v: 'second' });
    neighbour.commit();
    expect(branch.getValue([], 'box')).toEqual({ v: 'second' });
    expect(readsOf(branch)).toEqual({ box: { v: 'second' } });
  });

  it('in the second attempt of a stage whose first attempt failed', async () => {
    // A failed attempt's reads are dropped with its writes. What it had kept must be forgotten with
    // them, or the next attempt would find "already kept" and keep nothing.
    let attempts = 0;
    const chart = flowChart<State>(
      'Seed',
      (s) => {
        s.box = { n: 1 };
      },
      'seed',
    )
      .addFunction(
        'Twice',
        (s) => {
          read(s.box.n);
          attempts += 1;
          if (attempts === 1) throw new Error('first attempt fails');
        },
        'twice',
      )
      .retry({ attempts: 2 })
      .setLogger(quiet)
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(attempts).toBe(2);
    expect((executor.getSnapshot().executionTree as State).next.stageReads).toEqual({ box: { n: 1 } });
  });

  it('when a redaction rule has come into force for the key: the placeholder, never the copy', () => {
    // No engine path changes a key's verdict without writing the key. The rule is asked all the same:
    // what a read keeps under a verdict is not the value, and a copy kept before must not stand for it.
    const { frame } = rootFrame({ token: { secret: 's3cret' } });
    frame.getValue([], 'token');
    expect(readsOf(frame)).toEqual({ token: { secret: 's3cret' } });
    frame.useRedactionRule(new RedactionRule({ keys: ['token'] }));
    frame.getValue([], 'token');
    expect(readsOf(frame)).toEqual({ token: '[REDACTED]' });
    // And back: with the rule gone the value is kept again, not the placeholder left standing.
    frame.useRedactionRule(new RedactionRule());
    frame.getValue([], 'token');
    expect(readsOf(frame)).toEqual({ token: { secret: 's3cret' } });
  });

  it('when its copy could not be taken the first time', () => {
    // An object counts as kept only once its copy is there. A committed value can always be copied, so
    // the copy is made to fail here: the next read of the same object must keep it, not find it "kept".
    const { frame } = rootFrame({ box: { n: 1 } });
    const copy = vi.spyOn(globalThis, 'structuredClone').mockImplementationOnce(() => {
      throw new Error('could not be cloned');
    });
    try {
      expect(() => frame.getValue([], 'box')).toThrow('could not be cloned');
    } finally {
      copy.mockRestore();
    }
    expect(readsOf(frame)).toBeUndefined();
    frame.getValue([], 'box');
    expect(readsOf(frame)).toEqual({ box: { n: 1 } });
  });

  it('when the key no longer holds an object', () => {
    const state = { box: { v: 1 } as unknown };
    const mem = new SharedMemory(state);
    const log = new EventLog(state);
    const branch = new StageContext('br', 'Branch', 'branch', mem, '', log);
    branch.getValue([], 'box');
    const neighbour = new StageContext('', 'Neighbour', 'neighbour', mem, '', log);
    neighbour.setObject([], 'box', 'now a text');
    neighbour.commit();
    branch.getValue([], 'box');
    expect(readsOf(branch)).toEqual({ box: 'now a text' });
  });
});

describe('the one thing that moves: a value only read, then changed in place', () => {
  afterEach(() => disableDevMode());

  // Outside the contract: the record never sees such an edit, and committed state is changed with no
  // row. Before, a second read of the key copied the EDITED value over the first copy, which also hid
  // the edit from the dev-mode check (it holds the copy against the value at commit). Now the first
  // copy stands: `stageReads` says what the state held when it was read, and the check reports the edit.
  const editing = () =>
    flowChart<State>(
      'Seed',
      (s) => {
        s.box = { n: 1 };
      },
      'seed',
    )
      .addFunction(
        'Edit',
        (s) => {
          const raw = s.$getValue('box') as State;
          raw.n = 99;
          read(s.$getValue('box'));
        },
        'edit',
      )
      .setLogger(quiet)
      .build();

  it('stageReads keeps the value as it was first read', async () => {
    const executor = new FlowChartExecutor(editing());
    await executor.run();
    expect((executor.getSnapshot().executionTree as State).next.stageReads).toEqual({ box: { n: 1 } });
  });

  it('dev mode reports the edit although the key was read again after it', async () => {
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await new FlowChartExecutor(editing()).run();
      const told = warn.mock.calls.map((call) => String(call[0])).filter((text) => text.includes('IN PLACE'));
      expect(told).toHaveLength(1);
      expect(told[0]).toContain('`box.n`');
    } finally {
      warn.mockRestore();
    }
  });
});
