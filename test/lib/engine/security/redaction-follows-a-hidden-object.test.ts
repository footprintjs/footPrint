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
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { type S, ENCODINGS, KEYS, live, run, SECRET, served, shown, start } from './hidden-object-fixture.js';

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

    it.each([
      ['a place an earlier stage hid in it', KEYS, (s: S) => (s.a.b = s.secret)],
      ['a field the policy names', { keys: ['secret'], fields: { a: ['ssn'] } }, (s: S) => (s.a.ssn = SECRET)],
    ])(
      'a key whose old value moves below its new one (`a = { prev: a }`) takes %s along: the place it moved to is hidden',
      async (_what, policy, hide) => {
        const chart = start({ token: SECRET })
          .addFunction(
            'B',
            (s) => {
              hide(s);
            },
            'b',
          )
          .addFunction(
            'C',
            (s) => {
              s.a = { prev: s.a, depth: 2 };
            },
            'c',
          )
          .addFunction(
            'D',
            (s) => {
              s.$setValue('a', { prev: s.$getValue('a'), depth: 3 });
            },
            'd',
          )
          .build();
        const executor = await run(chart, commitValues, policy);

        expect(served(executor)).not.toContain(SECRET);
        expect(shown(executor).a).toEqual({ prev: 'REDACTED', depth: 3 });
        // Each move is one row: the search at commit finds the place hidden already, and no path grows.
        for (const stage of ['c', 'd']) {
          const bundle = executor.getSnapshot().commitLog.find((one) => one.stageId === stage);
          expect(bundle?.trace.map((row) => `${row.verb}:${row.path}`)).toEqual(['set:a']);
          expect(
            bundle?.redactedPaths?.some((path) => path.includes('prev.prev') || path.includes('prev\u001fprev')),
          ).toBe(false);
        }
      },
    );

    it('the same in ONE stage: the second write is hidden when it is made, in its event too', async () => {
      const chart = start({ token: SECRET })
        .addFunction(
          'B',
          (s) => {
            s.box = { p: s.secret };
            s.box = { prev: s.box };
          },
          'b',
        )
        .build();
      const executor = await run(chart, commitValues);

      expect(served(executor)).not.toContain(SECRET);
      expect(shown(executor).box).toEqual({ prev: 'REDACTED' });
    });

    it('a key that hides nothing moves its old value freely', async () => {
      const chart = start({ token: SECRET })
        .addFunction(
          'B',
          (s) => {
            s.$getValue('secret');
            s.a = { prev: s.a, depth: 2 };
          },
          'b',
        )
        .build();
      const executor = await run(chart, commitValues);
      expect(shown(executor).a).toEqual({ prev: { x: 1 }, depth: 2 });
    });

    it.each([
      ['at one place', (w: object) => ({ p: w }), { p: 'REDACTED' }],
      ['at two places', (w: object) => ({ p: w, q: w }), { p: 'REDACTED', q: 'REDACTED' }],
    ])(
      'inside a value that holds itself, %s: the place of that value is hidden whole',
      async (_where, build, expected) => {
        // A field is hidden in a copy, and the edge back leads to the value the copy was made of.
        const chart = start({ token: SECRET })
          .addFunction(
            'B',
            (s) => {
              const w: Record<string, unknown> = { s: s.$getValue('secret') };
              w.self = w;
              s.$setValue('box', build(w));
            },
            'b',
          )
          .build();
        const executor = await run(chart, commitValues);

        expect(served(executor)).not.toContain(SECRET);
        expect(shown(executor).box).toEqual(expected);
      },
    );

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

    it('the record AROUND such a list, copied whole: the list in the copy is hidden whole too', async () => {
      // The copy is handed the record's fields, and one of them names an index. The list is found in
      // the copy all the same: it goes whole there, because the index in the field will move.
      const chart = flowChart<S>(
        'A',
        (s) => {
          s.profile = { name: 'Ann', items: [{ ssn: SECRET }] };
        },
        'a',
      )
        .addFunction(
          'B',
          (s) => {
            s.copy = s.profile;
          },
          'b',
        )
        .addFunction(
          'C',
          (s) => {
            s.copy.items.unshift({ ssn: 'plain' });
          },
          'c',
        )
        .build();
      const executor = await run(chart, commitValues, { fields: { profile: ['items.0.ssn'] } });

      expect(live(executor).copy.items[1].ssn).toBe(SECRET);
      expect(JSON.stringify([executor.getSnapshot().commitLog, shown(executor).copy])).not.toContain(SECRET);
      expect(shown(executor).copy).toEqual({ name: 'Ann', items: 'REDACTED' });
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

  describe('an object taken from the stage’s input (`$getArgs()`)', () => {
    it('inside a sub-flowchart the input IS the parent’s hidden value: written on, or put in later, it is hidden', async () => {
      const inner = flowChart<S>(
        'In',
        (s) => {
          const handed = (s.$getArgs() as { secret: object }).secret;
          s.pub = { x: handed }; // when it is written
          const box: Record<string, unknown> = { n: 1 };
          s.$setValue('box', box);
          box.p = handed; // and put in after the write
        },
        'in',
      ).build();
      const chart = start({ token: SECRET })
        .addSubFlowChartNext('sf', inner as never, 'Mount', {
          inputMapper: (parent: { secret: unknown }) => ({ secret: parent.secret }),
          outputMapper: (child: { pub: unknown; box: unknown }) => ({ back: child.pub, box: child.box }),
        } as never)
        .build();
      const executor = await run(chart, commitValues);

      expect(live(executor).back.x.token).toBe(SECRET);
      expect(served(executor)).not.toContain(SECRET);
      expect(shown(executor).back).toEqual({ x: 'REDACTED' });
      expect(shown(executor).box).toEqual({ n: 1, p: 'REDACTED' });
    });

    it('a stage that is tried again: what it takes from its input in the second try is followed', async () => {
      let tries = 0;
      const inner = flowChart<S>(
        'In',
        (s) => {
          tries += 1;
          const handed = (s.$getArgs() as { secret: object }).secret;
          if (tries === 1) throw new Error('once');
          s.pub = { x: handed };
        },
        'in',
      )
        .retry({ attempts: 2 })
        .build();
      const chart = start({ token: SECRET })
        .addSubFlowChartNext('sf', inner as never, 'Mount', {
          inputMapper: (parent: { secret: unknown }) => ({ secret: parent.secret }),
          outputMapper: (child: { pub: unknown }) => ({ back: child.pub }),
        } as never)
        .build();
      const executor = await run(chart, commitValues);

      expect(tries).toBe(2);
      expect(live(executor).back.x.token).toBe(SECRET);
      expect(JSON.stringify([executor.getSnapshot().commitLog, shown(executor)])).not.toContain(SECRET);
      expect(shown(executor).back).toEqual({ x: 'REDACTED' });
    });

    it('the run’s own input: an object under a selected name in it, at any depth', async () => {
      const chart = flowChart<S>(
        'A',
        (s) => {
          const input = s.$getArgs() as { secret: object; order: { secret: object; note: object } };
          s.top = { held: input.secret };
          s.deep = { held: input.order.secret };
          s.open = { held: input.order.note }; // not under a selected name
        },
        'a',
      ).build();
      const executor = await run(chart, commitValues, KEYS, {
        secret: { token: SECRET },
        order: { secret: { token: SECRET }, note: { text: 'plain' } },
      });

      expect(live(executor).deep.held.token).toBe(SECRET);
      const plain = executor.getSnapshot();
      expect(JSON.stringify([plain.commitLog, shown(executor)])).not.toContain(SECRET);
      expect(shown(executor).top).toEqual({ held: 'REDACTED' });
      expect(shown(executor).deep).toEqual({ held: 'REDACTED' });
      expect(shown(executor).open).toEqual({ held: { text: 'plain' } });
    });

    it.each([
      [
        'a long list before it',
        KEYS,
        () => ({ wrap: { secret: { token: SECRET } }, big: Array.from({ length: 200_000 }, (_, i) => i) }),
        (input: any) => input.wrap.secret,
      ],
      [
        'the last record of a long list',
        KEYS,
        () => ({ rows: [...Array.from({ length: 200_000 }, (_, i) => ({ i })), { secret: { token: SECRET } }] }),
        (input: any) => input.rows[input.rows.length - 1].secret,
      ],
      [
        'a policy key with a dot in it',
        { keys: ['a.b'] },
        () => ({ a: { b: { token: SECRET } } }),
        (input: any) => input.a.b,
      ],
      [
        'a pattern over a path',
        { patterns: [/^auth\.token$/] },
        () => ({ auth: { token: { value: SECRET } } }),
        (input: any) => input.auth.token,
      ],
    ])('the input is read by the rule that serves it: %s', async (_what, policy, input, take) => {
      const chart = flowChart<S>(
        'A',
        (s) => {
          s.pub = { x: take(s.$getArgs()) };
        },
        'a',
      ).build();
      const executor = await run(chart, commitValues, policy, input());

      expect(JSON.stringify(live(executor).pub)).toContain(SECRET);
      const plain = executor.getSnapshot();
      expect(JSON.stringify([plain.commitLog, shown(executor).pub])).not.toContain(SECRET);
      expect(shown(executor).pub).toEqual({ x: 'REDACTED' });
    });

    it('a name marked by hand later in the run hides that key of the input for the stages after it', async () => {
      // What the rule hides in the input is kept for the run, and looked at again when a mark changes.
      type Input = { order: { late: object } };
      const chart = flowChart<S>(
        'A',
        (s) => {
          s.early = { x: (s.$getArgs() as Input).order.late }; // `late` is no selected name yet
          (s as S & { $setValue(key: string, value: unknown, redact: boolean): void }).$setValue(
            'late',
            'marked',
            true,
          );
        },
        'a',
      )
        .addFunction(
          'B',
          (s) => {
            s.after = { x: (s.$getArgs() as Input).order.late };
          },
          'b',
        )
        .build();
      const executor = await run(chart, commitValues, KEYS, { order: { late: { token: SECRET } } });

      expect(shown(executor).early).toEqual({ x: { token: SECRET } }); // written before the mark, as ever
      expect(shown(executor).after).toEqual({ x: 'REDACTED' });
    });

    it('the whole input copied under another name keeps every place the rule hides in it, texts too', async () => {
      const chart = flowChart<S>(
        'A',
        (s) => {
          s.copy = s.$getArgs();
        },
        'a',
      ).build();
      const executor = await run(chart, commitValues, KEYS, {
        secret: SECRET,
        order: { secret: SECRET, note: 'plain' },
      });

      expect(live(executor).copy.order.secret).toBe(SECRET);
      const plain = executor.getSnapshot();
      expect(JSON.stringify([plain.commitLog, shown(executor)])).not.toContain(SECRET);
      expect(shown(executor).copy).toEqual({ secret: 'REDACTED', order: { secret: 'REDACTED', note: 'plain' } });
    });
  });

  describe('many hidden objects under one key', () => {
    it('a public record that indexes a hidden list by id: every entry is hidden, a public one beside them is not', async () => {
      // 200 places under one key. The key takes them in one hand-over (`redaction.ts ·
      // inheritByIdentity`), and the walk that serves the record asks them once for the node
      // (`memory/pathTargets.ts`: a list this long is grouped by first key).
      const N = 200;
      const chart = flowChart<S>(
        'A',
        (s) => {
          s.secret = Array.from({ length: N }, (_, id) => ({ id, token: `${SECRET}-${id}` }));
        },
        'a',
      )
        .addFunction(
          'B',
          (s) => {
            const users = s.$getValue('secret') as { id: number }[];
            s.byId = { ...Object.fromEntries(users.map((user) => [`u${user.id}`, user])), note: { open: true } };
            s.wrapped = Object.fromEntries(users.map((user) => [`u${user.id}`, { owner: user, n: user.id }]));
          },
          'b',
        )
        .addFunction(
          'C',
          (s) => {
            // A later stage reads both: what its recorder is handed is hidden too.
            s.seen = [typeof s.$getValue('byId'), typeof s.$getValue('wrapped')];
            // And it looks every entry up through one handle, as a lookup table is used.
            const table = s.byId;
            let sum = 0;
            for (let id = 0; id < N; id++) sum += table[`u${id}`].id;
            s.sum = sum;
          },
          'c',
        )
        .build();
      const executor = await run(chart, commitValues);

      expect(live(executor).byId.u7.token).toBe(`${SECRET}-7`);
      expect(live(executor).sum).toBe((N * (N - 1)) / 2);
      expect(live(executor).wrapped.u199.owner.token).toBe(`${SECRET}-199`);
      expect(served(executor)).not.toContain(SECRET);
      const byId = shown(executor).byId as Record<string, unknown>;
      expect(byId.note).toEqual({ open: true });
      expect(Object.keys(byId)).toHaveLength(N + 1);
      expect(Object.values(byId).filter((value) => value === 'REDACTED')).toHaveLength(N);
      expect(shown(executor).wrapped.u0).toEqual({ owner: 'REDACTED', n: 0 });
      expect(shown(executor).wrapped.u199).toEqual({ owner: 'REDACTED', n: 199 });
    });
  });

  describe('a policy the caller changes between two runs', () => {
    it('a field added to the policy’s own list is followed in the next run', async () => {
      // What a list of paths says is kept only for a list that cannot change (`selectedObjects.ts ·
      // read`). The policy's list is the caller's: kept for it, the second run would follow `ssn` only.
      const policy = { fields: { profile: ['ssn'] } };
      const chart = flowChart<S>(
        'A',
        (s) => {
          s.profile = { name: 'Ada', ssn: { digits: `${SECRET}-ssn` }, card: { number: `${SECRET}-card` } };
        },
        'a',
      )
        .addFunction(
          'B',
          (s) => {
            const profile = s.$getValue('profile') as { ssn: object; card: object };
            s.copy = { ssn: profile.ssn, card: profile.card };
          },
          'b',
        )
        .build();
      const executor = new FlowChartExecutor(chart as never, { commitValues } as never);
      executor.setRedactionPolicy(policy as never);
      await executor.run();
      expect(executor.getSnapshot({ redact: true }).sharedState.copy).toEqual({
        ssn: 'REDACTED',
        card: { number: `${SECRET}-card` }, // not in the policy yet
      });

      policy.fields.profile.push('card');
      await executor.run();
      expect(executor.getSnapshot({ redact: true }).sharedState.copy).toEqual({ ssn: 'REDACTED', card: 'REDACTED' });
      expect(JSON.stringify(executor.getSnapshot().commitLog)).not.toContain(SECRET);
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
