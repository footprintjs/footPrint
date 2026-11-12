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

/** Everything the run keeps or serves under the policy, as one text: the log, and the redacted views. */
function served(executor: FlowChartExecutor<never, never>): string {
  const plain = executor.getSnapshot();
  const redacted = executor.getSnapshot({ redact: true });
  return JSON.stringify([plain.commitLog, redacted.sharedState, redacted.subflowResults ?? null]);
}

async function run(chart: unknown, commitValues: CommitValuesMode, policy: object = KEYS) {
  const executor = new FlowChartExecutor(chart as never, { commitValues } as never);
  executor.setRedactionPolicy(policy as never);
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
