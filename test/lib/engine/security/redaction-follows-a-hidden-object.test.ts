/**
 * A hidden object keeps its rule wherever a stage puts it.
 *
 * Redaction selects by name. The one thing a copy keeps without a name is its identity: an object a
 * stage read under a hidden name is still that object when the stage writes it somewhere else. Until
 * this change that held for one shape only, `scope.copy = scope.secret`: the whole hidden value, as
 * the whole value of a top key. Every other way of passing the object on went to the commit log and
 * the redacted state in the clear:
 *
 *   - an object INSIDE the hidden value (`scope.copy = scope.secret.inner`, an item of a hidden list,
 *     a record below a hidden field);
 *   - the object put INSIDE another value (`scope.a.b = scope.secret`, `scope.box = { p: scope.secret }`,
 *     `scope.list.push(scope.secret)`, `$update('a', { b: scope.secret })`).
 *
 * Found 2026-11-12 by the second reader of the change before this one. Each program below that names
 * a leak leaked before this change, through the public API (`memory/selectedObjects.ts` says why and
 * how it is closed).
 *
 * What is hidden where:
 *   - below a top key, the place is hidden and its neighbours are not (`a: { x: 1, b: 'REDACTED' }`);
 *   - a list that holds a hidden object is hidden whole, because an index moves.
 *
 * Test type: security scenario.
 */
import type { CommitValuesMode } from 'foottrace';
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';

type S = Record<string, any> & {
  $getValue(key: string): any;
  $setValue(key: string, value: unknown): void;
  $update(key: string, value: unknown): void;
};

const SECRET = 'sk-live-SUPER-SECRET-BYTES';
const KEYS = { keys: ['secret'] };
const ENCODINGS: CommitValuesMode[] = ['full', 'delta'];

/** What a recorder was handed at each read, write and commit, turned into text AT ONCE, as a log sink does. */
const events = new WeakMap<object, string[]>();

/**
 * Everything the run keeps or serves under the policy, as one text: the log, what each stage kept of its
 * reads and writes (the execution tree), the whole redacted snapshot, and every event a recorder was
 * handed while the run went on. Not the plain live state: that is real by design.
 */
function served(executor: FlowChartExecutor<never, never>): string {
  const plain = executor.getSnapshot();
  return JSON.stringify([
    plain.commitLog,
    plain.executionTree,
    executor.getSnapshot({ redact: true }),
    events.get(executor) ?? [],
  ]);
}

async function run(chart: unknown, commitValues: CommitValuesMode, policy: object = KEYS) {
  const executor = new FlowChartExecutor(chart as never, { commitValues } as never);
  executor.setRedactionPolicy(policy as never);
  const seen: string[] = [];
  events.set(executor, seen);
  const keep = (event: unknown) => {
    seen.push(JSON.stringify(event, (_key, value) => (value instanceof Map ? [...value] : value)));
  };
  executor.attachScopeRecorder({ id: 'sink', onRead: keep, onWrite: keep, onCommit: keep });
  await executor.run();
  return executor as FlowChartExecutor<never, never>;
}

/** Stage `A` writes the hidden value and a public record `a`. What follows is the test's. */
const start = (secret: unknown) =>
  flowChart<S>(
    'A',
    (s) => {
      s.secret = secret;
      s.a = { x: 1 };
    },
    'a',
  );

const live = (executor: FlowChartExecutor<never, never>) => executor.getSnapshot().sharedState as Record<string, any>;
const shown = (executor: FlowChartExecutor<never, never>) =>
  executor.getSnapshot({ redact: true }).sharedState as Record<string, any>;

describe.each(ENCODINGS)('a hidden object keeps its rule wherever a stage puts it (%s)', (commitValues) => {
  describe('the object put inside another value', () => {
    it.each([
      ['a list', [SECRET]],
      ['a record', { token: SECRET }],
    ])('assigned at a nested path, %s: the place is hidden, its neighbour is not', async (_what, secret) => {
      const chart = start(secret)
        .addFunction(
          'B',
          (s) => {
            s.a.b = s.secret;
          },
          'b',
        )
        .build();
      const executor = await run(chart, commitValues);

      expect(live(executor).a.b).toEqual(secret); // the program ran, and the live value is real
      expect(served(executor)).not.toContain(SECRET);
      expect(shown(executor).a).toEqual({ x: 1, b: 'REDACTED' });
    });

    it('placed in a new object, at any depth', async () => {
      const chart = start({ token: SECRET })
        .addFunction(
          'B',
          (s) => {
            s.box = { p: s.secret, note: 'n' };
            s.deep = { inner: { p: s.secret }, note: 'n' };
          },
          'b',
        )
        .build();
      const executor = await run(chart, commitValues);

      expect(live(executor).deep.inner.p.token).toBe(SECRET);
      expect(served(executor)).not.toContain(SECRET);
      expect(shown(executor).box).toEqual({ p: 'REDACTED', note: 'n' });
      expect(shown(executor).deep).toEqual({ inner: { p: 'REDACTED' }, note: 'n' });
    });

    it('placed in a list, or pushed into one: the list is hidden whole', async () => {
      const chart = flowChart<S>(
        'A',
        (s) => {
          s.secret = { token: SECRET };
          s.grown = [{ id: 1 }];
        },
        'a',
      )
        .addFunction(
          'B',
          (s) => {
            s.list = [s.secret];
            s.grown.push(s.secret);
            s.box = { items: [s.secret], note: 'n' };
          },
          'b',
        )
        .build();
      const executor = await run(chart, commitValues);

      expect(live(executor).grown).toEqual([{ id: 1 }, { token: SECRET }]);
      expect(served(executor)).not.toContain(SECRET);
      expect(shown(executor).list).toBe('REDACTED');
      expect(shown(executor).grown).toBe('REDACTED');
      expect(shown(executor).box).toEqual({ items: 'REDACTED', note: 'n' });
    });

    it('handed to `$setValue` and `$update` inside a value', async () => {
      const chart = start({ token: SECRET })
        .addFunction(
          'B',
          (s) => {
            s.$setValue('box', { p: s.$getValue('secret') });
            s.$update('a', { b: s.$getValue('secret') });
          },
          'b',
        )
        .build();
      const executor = await run(chart, commitValues);

      expect(live(executor).a.b.token).toBe(SECRET);
      expect(served(executor)).not.toContain(SECRET);
      expect(shown(executor).box).toEqual({ p: 'REDACTED' });
      expect(shown(executor).a).toEqual({ x: 1, b: 'REDACTED' });
    });

    it('one new object placed at two places of a value: both places are hidden', async () => {
      const chart = start({ token: SECRET })
        .addFunction(
          'B',
          (s) => {
            // A raw read, so that `part` is ONE object at three places when it is written.
            const part = { p: s.$getValue('secret'), note: 'n' };
            s.$setValue('box', { first: part, second: part, listed: [part] });
          },
          'b',
        )
        .build();
      const executor = await run(chart, commitValues);

      expect(live(executor).box.second.p.token).toBe(SECRET);
      expect(served(executor)).not.toContain(SECRET);
      // The place it is found at first is hidden exactly (here that is the list, which goes whole). The
      // same object at another place is hidden whole: that it holds one is known, and where in it is
      // not worth a second walk.
      expect(shown(executor).box).toEqual({ first: 'REDACTED', second: 'REDACTED', listed: 'REDACTED' });
    });

    it('put into an object AFTER the stage wrote that object: the record takes a value as it stands at commit', async () => {
      const chart = start({ token: SECRET })
        .addFunction(
          'B',
          (s) => {
            const box: Record<string, unknown> = { x: 1 };
            s.$setValue('box', box); // nothing hidden in it yet
            box.p = s.$getValue('secret'); // and now there is, with no write to show it
          },
          'b',
        )
        .build();
      const executor = await run(chart, commitValues);

      expect(live(executor).box.p.token).toBe(SECRET);
      expect(served(executor)).not.toContain(SECRET);
      expect(shown(executor).box).toEqual({ x: 1, p: 'REDACTED' });
    });

    it('a key that was searched when it was written is not written again at commit: its row keeps the reads it was built on', async () => {
      const chart = start({ token: SECRET })
        .addFunction(
          'B',
          (s) => {
            s.$setValue('box', { x: 1, p: s.$getValue('secret') }); // found here, when it is written
            s.seen = s.$getValue('a'); // a read AFTER that write: `box` was not built on it
          },
          'b',
        )
        .build();
      const executor = new FlowChartExecutor(
        chart as never,
        { commitValues, writeProvenance: 'reads-prefix' } as never,
      );
      executor.setRedactionPolicy(KEYS as never);
      await executor.run();

      const written = executor.getSnapshot().commitLog.find((bundle) => bundle.stageId === 'b');
      const row = written?.trace.find((entry) => entry.path === 'box');
      expect(row).toEqual({ path: 'box', verb: 'set', readKeys: ['secret'] });
      expect(JSON.stringify(executor.getSnapshot().commitLog)).not.toContain(SECRET);
    });

    it('put into an object the stage holds, and the same object written back', async () => {
      const chart = start({ token: SECRET })
        .addFunction(
          'B',
          (s) => {
            s.$setValue('box', { x: 1 });
            const held = s.$getValue('box') as Record<string, unknown>; // the stage's own copy now
            held.p = s.$getValue('secret');
            s.$setValue('box', held); // the same object: nothing of it may be passed over
          },
          'b',
        )
        .build();
      const executor = await run(chart, commitValues);

      expect(live(executor).box.p.token).toBe(SECRET);
      expect(served(executor)).not.toContain(SECRET);
      expect(shown(executor).box).toEqual({ x: 1, p: 'REDACTED' });
    });

    it('as the key of a Map, or the cause of an Error: the Map and the Error are hidden whole', async () => {
      const chart = start({ token: SECRET })
        .addFunction(
          'B',
          (s) => {
            const secret = s.$getValue('secret');
            s.$setValue('byKey', new Map([[secret, 1]]));
            s.$setValue('failed', { at: 'step 2', error: new Error('refused', { cause: secret }) });
          },
          'b',
        )
        .build();
      const executor = await run(chart, commitValues);

      expect((live(executor).failed.error as Error).cause).toEqual({ token: SECRET });
      expect(served(executor)).not.toContain(SECRET);
      expect(shown(executor).byKey).toBe('REDACTED');
      expect(shown(executor).failed).toEqual({ at: 'step 2', error: 'REDACTED' });
    });

    it('at a key the record cannot name (`constructor`, `prototype`, a dotted key below another): the place above it', async () => {
      const chart = start({ token: SECRET })
        .addFunction(
          'B',
          (s) => {
            const secret = s.$getValue('secret');
            s.$setValue('made', { by: { constructor: secret, note: 'n' } });
            s.$setValue('typed', { prototype: secret });
            s.$setValue('dotted', { 'a.b': secret, open: 1 });
            s.$setValue('below', { 'a.b': { deep: secret }, open: 1 });
          },
          'b',
        )
        .build();
      const executor = await run(chart, commitValues);

      expect(live(executor).made.by.note).toBe('n');
      expect(served(executor)).not.toContain(SECRET);
      expect(shown(executor).made).toEqual({ by: 'REDACTED' });
      expect(shown(executor).typed).toBe('REDACTED');
      expect(shown(executor).dotted).toEqual({ 'a.b': 'REDACTED', open: 1 });
      expect(shown(executor).below).toBe('REDACTED');
    });

    it('a policy that names a field the record cannot reach hides the whole value in the record', async () => {
      // Older than this change: `fields: { box: ['constructor'] }` hid nothing in the commit log, because
      // the record's scrub refuses that name.
      const chart = flowChart<S>(
        'A',
        (s) => {
          s.$setValue('box', { constructor: SECRET, note: 'n' });
        },
        'a',
      ).build();
      const executor = await run(chart, commitValues, { fields: { box: ['constructor'] } });

      expect(live(executor).box.note).toBe('n');
      expect(JSON.stringify(executor.getSnapshot().commitLog)).not.toContain(SECRET);
      expect(shown(executor).box).toBe('REDACTED');
    });

    it('stays hidden when later stages write beside it, into it, or the whole key again', async () => {
      const chart = start([SECRET])
        .addFunction(
          'B',
          (s) => {
            s.a.b = s.secret;
          },
          'b',
        )
        .addFunction(
          'C',
          (s) => {
            s.a.y = 2; // beside it
            s.a.b.unshift('more'); // into it
          },
          'c',
        )
        .addFunction(
          'D',
          (s) => {
            s.a = { ...s.a, z: 3 }; // the whole key again, with the same list inside
          },
          'd',
        )
        .build();
      const executor = await run(chart, commitValues);

      expect(live(executor).a).toEqual({ x: 1, y: 2, z: 3, b: ['more', SECRET] });
      expect(served(executor)).not.toContain(SECRET);
      expect(shown(executor).a).toEqual({ x: 1, y: 2, z: 3, b: 'REDACTED' });
    });
  });

  describe('an object inside the hidden value', () => {
    it('a member, read through the scope or through a raw read', async () => {
      const chart = start({ inner: { token: SECRET } })
        .addFunction(
          'B',
          (s) => {
            s.copy = s.secret.inner;
            s.raw = s.$getValue('secret').inner;
          },
          'b',
        )
        .build();
      const executor = await run(chart, commitValues);

      expect(live(executor).copy.token).toBe(SECRET);
      expect(served(executor)).not.toContain(SECRET);
      expect(shown(executor).copy).toBe('REDACTED');
      expect(shown(executor).raw).toBe('REDACTED');
    });

    it('a member the stage itself changed, read through a handle it held from before', async () => {
      const chart = start({ inner: { token: SECRET } })
        .addFunction(
          'B',
          (s) => {
            const held = s.secret; // a handle, taken before the change
            s.secret.inner.note = 'n'; // the stage writes into the hidden value: `inner` is a new object now
            s.copy = held.inner; // the handle reads the new one, and that is not a tracked read
          },
          'b',
        )
        .build();
      const executor = await run(chart, commitValues);

      expect(live(executor).copy).toEqual({ token: SECRET, note: 'n' });
      expect(served(executor)).not.toContain(SECRET);
      expect(shown(executor).copy).toBe('REDACTED');
    });

    it('taken out of the whole state, read with no key', async () => {
      const chart = start({ inner: { token: SECRET } })
        .addFunction(
          'B',
          (s) => {
            const state = s.$getValue() as Record<string, any>; // everything, by one read
            s.copy = state.secret;
            s.deeper = { held: state.secret.inner };
          },
          'b',
        )
        .build();
      const executor = await run(chart, commitValues);

      expect(live(executor).deeper.held.token).toBe(SECRET);
      expect(served(executor)).not.toContain(SECRET);
      expect(shown(executor).copy).toBe('REDACTED');
      expect(shown(executor).deeper).toEqual({ held: 'REDACTED' });
    });

    it('a hidden list whose policy names an index: a copy of the list is hidden whole', async () => {
      const chart = flowChart<S>(
        'A',
        (s) => {
          s.users = [{ name: 'Ann', ssn: SECRET }, { name: 'Bob' }];
        },
        'a',
      )
        .addFunction(
          'B',
          (s) => {
            s.copy = s.users;
          },
          'b',
        )
        .addFunction(
          'C',
          (s) => {
            s.copy.unshift({ name: 'Cy' }); // the index moves: a rule by index would now hide Cy
          },
          'c',
        )
        .build();
      const executor = await run(chart, commitValues, { fields: { users: ['0.ssn'] } });

      expect(live(executor).copy[1].ssn).toBe(SECRET);
      expect(JSON.stringify(shown(executor).copy)).not.toContain(SECRET);
      expect(shown(executor).copy).toBe('REDACTED');
    });

    it('an item of a hidden list, also when it is taken with `find`', async () => {
      const chart = start([{ id: 1, token: SECRET }])
        .addFunction(
          'B',
          (s) => {
            s.first = s.secret[0];
            s.found = (s.secret as { id: number }[]).find((item) => item.id === 1);
          },
          'b',
        )
        .build();
      const executor = await run(chart, commitValues);

      expect(live(executor).found.token).toBe(SECRET);
      expect(served(executor)).not.toContain(SECRET);
      expect(shown(executor).first).toBe('REDACTED');
      expect(shown(executor).found).toBe('REDACTED');
    });

    it('an item taken out of the copy `$batchArray` hands a stage, and a hidden object pushed in through it', async () => {
      let taken: unknown;
      const chart = flowChart<S>(
        'A',
        (s) => {
          s.secret = [{ token: SECRET }];
          s.open = [{ id: 1 }];
        },
        'a',
      )
        .addFunction(
          'B',
          (s) => {
            (s as S & { $batchArray(key: string, fn: (list: unknown[]) => void): void }).$batchArray(
              'secret',
              (list) => {
                taken = list[0]; // an item of the COPY of the hidden list
              },
            );
            s.copy = taken;
            (s as S & { $batchArray(key: string, fn: (list: unknown[]) => void): void }).$batchArray('open', (list) => {
              list.push(taken);
            });
          },
          'b',
        )
        .build();
      const executor = await run(chart, commitValues);

      expect(live(executor).copy).toEqual({ token: SECRET });
      expect(live(executor).open).toEqual([{ id: 1 }, { token: SECRET }]);
      expect(served(executor)).not.toContain(SECRET);
      expect(shown(executor).copy).toBe('REDACTED');
      expect(shown(executor).open).toBe('REDACTED');
    });

    it('a record hidden by its fields that also holds another hidden object: both rules follow it', async () => {
      // `profile.email` is hidden by the policy. The stage puts the hidden `secret` into the profile it
      // read, and writes that profile under another name: the field, and the place of the secret.
      const chart = flowChart<S>(
        'A',
        (s) => {
          s.secret = { token: SECRET };
          s.profile = { name: 'Ann', email: `${SECRET}@example.test` };
        },
        'a',
      )
        .addFunction(
          'B',
          (s) => {
            s.profile.pal = s.secret;
          },
          'b',
        )
        .addFunction(
          'C',
          (s) => {
            s.copy = s.profile;
          },
          'c',
        )
        .build();
      const executor = await run(chart, commitValues, { keys: ['secret'], fields: { profile: ['email'] } });

      expect(live(executor).copy.pal.token).toBe(SECRET);
      expect(served(executor)).not.toContain(SECRET);
      expect(shown(executor).copy).toEqual({ name: 'Ann', email: 'REDACTED', pal: 'REDACTED' });
    });

    it('a record below a hidden FIELD keeps the field hidden, and shows the rest', async () => {
      const chart = flowChart<S>(
        'A',
        (s) => {
          s.profile = { name: 'Ann', contact: { email: SECRET, city: 'Oslo' } };
        },
        'a',
      )
        .addFunction(
          'B',
          (s) => {
            s.copy = s.profile.contact; // holds the hidden field
            s.card = { owner: s.profile.contact }; // and inside a new object
          },
          'b',
        )
        .build();
      const executor = await run(chart, commitValues, { fields: { profile: ['contact.email'] } });

      expect(live(executor).card.owner.email).toBe(SECRET);
      expect(served(executor)).not.toContain(SECRET);
      expect(shown(executor).copy).toEqual({ email: 'REDACTED', city: 'Oslo' });
      expect(shown(executor).card).toEqual({ owner: { email: 'REDACTED', city: 'Oslo' } });
    });
  });

  describe('what stays as it was', () => {
    it('control: the whole hidden value as the whole value of a top key', async () => {
      const chart = start({ token: SECRET })
        .addFunction(
          'B',
          (s) => {
            s.copy = s.secret;
          },
          'b',
        )
        .build();
      const executor = await run(chart, commitValues);
      expect(served(executor)).not.toContain(SECRET);
      expect(shown(executor).copy).toBe('REDACTED');
    });

    it('the stated limit: a text has no identity, so a copy of one is hidden by its own name only', async () => {
      const chart = start({ token: SECRET })
        .addFunction(
          'B',
          (s) => {
            s.spread = { ...s.secret }; // copies the text, not the object
            s.text = s.secret.token;
          },
          'b',
        )
        .build();
      const executor = await run(chart, commitValues);
      // Not followed, as the guide says: name such a key in the policy, or mark it by hand.
      expect(shown(executor).spread).toEqual({ token: SECRET });
      expect(shown(executor).text).toBe(SECRET);
    });

    it('one object a stage puts under a public name and a hidden name stays shown under the public one', async () => {
      // The stage's own object, at two places of its own making. Reading it back under the hidden name
      // does not reach back to where it already sat.
      const chart = start({ token: SECRET })
        .addFunction(
          'B',
          (s) => {
            const note = { text: 'public' };
            s.$setValue('open', note);
            s.$setValue('secret', note); // the hidden key now holds the same object
            s.seen = typeof s.$getValue('secret');
          },
          'b',
        )
        .build();
      const executor = await run(chart, commitValues);
      expect(shown(executor).open).toEqual({ text: 'public' });
      expect(shown(executor).secret).toBe('REDACTED');
    });

    it('KNOWN LIMIT: an object the stage itself hid in this stage, read back, then put IN PLACE into a value it had already written', async () => {
      // Followed in every value the stage writes after reading it back. Not followed back in time into a
      // value written before, with no write after it: the search at commit follows only what came from
      // committed state (`memory/selectedObjects.ts`, why). Writing the value again closes it.
      const made = { token: SECRET };
      const program = (writeAgain: boolean) =>
        flowChart<S>(
          'A',
          (s) => {
            const box: Record<string, unknown> = { x: 1 };
            s.$setValue('box', box);
            s.$setValue('secret', made); // hidden by the policy, in THIS stage
            box.p = s.$getValue('secret'); // in place, after the write of `box`
            if (writeAgain) s.$setValue('box', box);
          },
          'a',
        ).build();
      const limit = await run(program(false), commitValues);
      expect(JSON.stringify(limit.getSnapshot().commitLog)).toContain(SECRET); // the limit, pinned
      const closed = await run(program(true), commitValues);
      expect(served(closed)).not.toContain(SECRET);
      expect(shown(closed).box).toEqual({ x: 1, p: 'REDACTED' });
    });

    it('a stage that read nothing hidden pays nothing and hides nothing', async () => {
      const chart = start({ token: SECRET })
        .addFunction(
          'B',
          (s) => {
            s.a.b = { public: true };
            s.list = [{ id: 1 }];
          },
          'b',
        )
        .build();
      const executor = await run(chart, commitValues);
      expect(shown(executor).a).toEqual({ x: 1, b: { public: true } });
      expect(shown(executor).list).toEqual([{ id: 1 }]);
    });

    it('the mark ends as any other: the stage that deletes the key ends it, and a new value is shown', async () => {
      const chart = start({ token: SECRET })
        .addFunction(
          'B',
          (s) => {
            s.a.b = s.secret;
          },
          'b',
        )
        .addFunction(
          'Forget',
          (s) => {
            delete (s as Record<string, unknown>).a;
          },
          'forget',
        )
        .addFunction(
          'New',
          (s) => {
            s.a = { b: 'public' };
          },
          'new',
        )
        .build();
      const executor = await run(chart, commitValues);
      expect(served(executor)).not.toContain(SECRET);
      expect(shown(executor).a).toEqual({ b: 'public' });
    });
  });
});
