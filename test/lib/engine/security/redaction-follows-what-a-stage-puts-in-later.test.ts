/**
 * A hidden object put into a value AFTER the stage wrote it, and what must NOT change because of it.
 *
 * The record takes a value as it stands when the stage commits. A stage that writes an object and then
 * puts a hidden one into it (`s.box = o; o.p = s.secret`) records `p`, and no write ever showed it. So
 * every key a stage wrote is searched once more at commit (`memory/hiddenObjectTrail.ts`).
 *
 * That search has one job, and both halves of it are tested here:
 *   - it FINDS what was put in after the write, whatever the stage did to the hidden key in between
 *     (found 2026-11-12 by the second reader: after any write of the hidden key the stage reads back
 *     new objects, and the first cut took them for the stage's own);
 *   - it changes NOTHING else: not a key the stage only read and merged into, not an object the stage
 *     had written under a public name before it hid it.
 *
 * Test type: security scenario. The programs at a write are `redaction-follows-a-hidden-object.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { type S, ENCODINGS, events, KEYS, live, run, SECRET, served, shown, start } from './hidden-object-fixture.js';

describe.each(ENCODINGS)('a hidden object put in after the write (%s)', (commitValues) => {
  describe('it is found at commit', () => {
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

    it.each([
      ['merged into it', (s: S) => s.$update('secret', { note: 'touched' })],
      ['set one field of it through the scope', (s: S) => (s.secret.note = 'touched')],
      ['pushed onto a list inside it', (s: S) => s.secret.items.push({ n: 2 })],
      ['written all of it back as a new record', (s: S) => s.$setValue('secret', { ...s.$getValue('secret') })],
    ])(
      'put in after the write, by a stage that had %s: what it reads back is new objects, and hidden all the same',
      async (_how, writeTheHiddenKey) => {
        // Once a stage writes a key, a read of it hands out the record's own copies. They are not the
        // objects the state held, and they hold the same hidden content.
        const chart = start({ inner: { token: SECRET }, items: [{ n: 1 }] })
          .addFunction(
            'B',
            (s) => {
              s.$getValue('secret');
              writeTheHiddenKey(s);
              const box: Record<string, unknown> = { x: 1 };
              s.$setValue('box', box);
              box.p = (s.$getValue('secret') as { inner: object }).inner; // in place, after the write of `box`
            },
            'b',
          )
          .build();
        const executor = await run(chart, commitValues);

        expect(live(executor).box.p.token).toBe(SECRET);
        expect(served(executor)).not.toContain(SECRET);
        expect(shown(executor).box).toEqual({ x: 1, p: 'REDACTED' });
      },
    );

    it('a record hidden by one field, changed and read back: the hidden member put in place is hidden there', async () => {
      const chart = flowChart<S>(
        'A',
        (s) => {
          s.profile = { name: 'Ada', contact: { email: SECRET } };
        },
        'a',
      )
        .addFunction(
          'B',
          (s) => {
            s.$update('profile', { visits: 2 });
            const box: Record<string, unknown> = { x: 1 };
            s.$setValue('box', box);
            box.p = (s.$getValue('profile') as { contact: object }).contact;
          },
          'b',
        )
        .build();
      const executor = await run(chart, commitValues, { fields: { profile: ['contact'] } });

      expect(served(executor)).not.toContain(SECRET);
      expect(shown(executor).box).toEqual({ x: 1, p: 'REDACTED' });
      expect(shown(executor).profile).toEqual({ name: 'Ada', contact: 'REDACTED', visits: 2 });
    });

    it('a copy the scope itself made of a hidden record (a write below it), read back and put in place: all of it is hidden', async () => {
      // A write below a list rebuilds the record around it. The rebuilt record holds the hidden record's
      // own texts, so it must count as the hidden record, not as an object the stage made.
      const chart = start({ apiKey: SECRET, items: [{ v: 1 }] })
        .addFunction(
          'B',
          (s) => {
            const box: Record<string, unknown> = { x: 1 };
            s.$setValue('box', box);
            s.secret.items[0].v = 2;
            box.p = s.$getValue('secret');
          },
          'b',
        )
        .build();
      const executor = await run(chart, commitValues);

      expect(live(executor).box.p.apiKey).toBe(SECRET);
      expect(served(executor)).not.toContain(SECRET);
      expect(shown(executor).box).toEqual({ x: 1, p: 'REDACTED' });
    });

    it.each([
      ['a write below a key through the scope', (s: S, row: object) => (s.a.row = row)],
      ['`$update`', (s: S, row: object) => s.$update('a', { row })],
    ])(
      'put into the patch of a merge (%s) after the write: the record never took it, and what the stage KEPT of the write hides it',
      async (_how, write) => {
        // The record copies a patch when it merges it. The stage keeps the patch itself for its snapshot,
        // and takes the kept form at commit: what was put into the patch in between is in that form.
        const chart = start({ token: SECRET })
          .addFunction(
            'B',
            (s) => {
              const row: Record<string, unknown> = { n: 1 };
              write(s, row);
              row.owner = s.$getValue('secret');
            },
            'b',
          )
          .build();
        const executor = await run(chart, commitValues);

        expect(live(executor).a).toEqual({ x: 1, row: { n: 1 } }); // it never landed
        expect(served(executor)).not.toContain(SECRET); // the execution tree and the commit event
        const written = executor.getSnapshot().commitLog.find((bundle) => bundle.stageId === 'b');
        expect(written?.trace.map((row) => `${row.verb}:${row.path}`)).toEqual(['merge:a']);
        expect(written?.redactedPaths ?? []).toEqual([]); // and no rule of the run changed for it
      },
    );

    it('a find at commit that hides the whole key marks it: a later stage that copies the key copies it hidden', async () => {
      const chart = start({ token: SECRET })
        .addFunction(
          'B',
          (s) => {
            const list: unknown[] = [];
            s.$setValue('list', list);
            list.push(s.$getValue('secret')); // in place: a list that holds a hidden object is hidden whole
          },
          'b',
        )
        .addFunction(
          'C',
          (s) => {
            s.copy = s.list;
          },
          'c',
        )
        .build();
      const executor = await run(chart, commitValues);

      expect(served(executor)).not.toContain(SECRET);
      expect(shown(executor).list).toBe('REDACTED');
      expect(shown(executor).copy).toBe('REDACTED');
    });

    it('a try that was thrown away wrote nothing: what it put under a public key does not excuse the next try', async () => {
      // Try 1 writes its own object under `a` and fails. Try 2 hides that object, reads it back, changes
      // `a` and puts the object into it in place. What try 1 wrote under `a` was never written.
      const own = { token: SECRET };
      let tries = 0;
      const chart = start({ token: 'another' })
        .addFunction(
          'B',
          (s) => {
            tries += 1;
            s.$getValue('secret');
            if (tries === 1) {
              s.$setValue('a', { p: own });
              throw new Error('once');
            }
            s.$setValue('hidden', own);
            const back = s.$getValue('hidden');
            s.a.y = 2;
            s.$getValue('a').p = back; // in place
          },
          'b',
        )
        .retry({ attempts: 2 })
        .build();
      const executor = await run(chart, commitValues, { keys: ['secret', 'hidden'] });

      expect(tries).toBe(2);
      expect(JSON.stringify([executor.getSnapshot().commitLog, shown(executor)])).not.toContain(SECRET);
      expect(shown(executor).a).toEqual({ x: 1, y: 2, p: 'REDACTED' });
    });

    it('a place hidden at commit ends as any other: the stage that deletes the key ends it, and a new value is shown', async () => {
      const chart = start({ token: SECRET })
        .addFunction(
          'B',
          (s) => {
            const box: Record<string, unknown> = { x: 1 };
            s.$setValue('box', box);
            box.p = s.$getValue('secret');
          },
          'b',
        )
        .addFunction(
          'C',
          (s) => {
            delete s.box;
          },
          'c',
        )
        .addFunction(
          'D',
          (s) => {
            s.box = { p: 'plain' };
          },
          'd',
        )
        .build();
      const executor = await run(chart, commitValues);

      expect(served(executor)).not.toContain(SECRET);
      expect(shown(executor).box).toEqual({ p: 'plain' });
    });
    it('put ANYWHERE ELSE after it was read back, the same object is followed: also in place, into a value written before', async () => {
      // What stays shown is the place the stage itself wrote it at before it was hidden, nothing more.
      const made = { token: SECRET };
      const chart = flowChart<S>(
        'A',
        (s) => {
          const box: Record<string, unknown> = { x: 1 };
          s.$setValue('box', box);
          s.$setValue('secret', made); // hidden by the policy, in THIS stage
          box.p = s.$getValue('secret'); // in place, after the write of `box`
        },
        'a',
      ).build();
      const executor = await run(chart, commitValues);
      expect(served(executor)).not.toContain(SECRET);
      expect(shown(executor).box).toEqual({ x: 1, p: 'REDACTED' });
    });
  });

  describe('nothing else changes', () => {
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

    it.each([
      ['the key itself', (s: S) => s.a],
      ['a record inside it', (s: S) => s.$getValue('a').x],
    ])(
      'a public key the stage changed, then %s copied under a hidden name and read back: the public key stays as it was',
      async (_what, taken) => {
        // The record builds new containers for a change below a key. They are what the stage wrote, under
        // a public name. Hiding a copy of one afterwards does not reach back to it.
        const chart = flowChart<S>(
          'A',
          (s) => {
            s.secret = { token: SECRET };
            s.a = { x: { y: 1 } };
          },
          'a',
        )
          .addFunction(
            'B',
            (s) => {
              s.$getValue('secret'); // from here on every write is searched
              s.a.x.n = 1;
              s.$setValue('hidden', taken(s));
              s.$getValue('hidden');
            },
            'b',
          )
          .build();
        const executor = await run(chart, commitValues, { keys: ['secret', 'hidden'] });

        expect(shown(executor).a).toEqual({ x: { y: 1, n: 1 } });
        expect(shown(executor).hidden).toBe('REDACTED');
        const written = executor.getSnapshot().commitLog.find((bundle) => bundle.stageId === 'b');
        expect(written?.trace.filter((row) => row.path === 'a').map((row) => row.verb)).toEqual(['merge']);
      },
    );

    it.each([
      [
        'a list the policy names by index',
        { fields: { profile: ['items.0.ssn'] } },
        () => ({ items: [{ ssn: SECRET, name: 'visible-name' }] }),
        { items: [{ ssn: 'REDACTED', name: 'visible-name' }], n: 2 },
      ],
      [
        'one object at a hidden and at a public place',
        { fields: { profile: ['ssn'] } },
        () => {
          const both = { v: 'visible-shared' };
          return { ssn: both, backup: both };
        },
        { ssn: 'REDACTED', backup: { v: 'visible-shared' }, n: 2 },
      ],
      [
        'one object at a hidden place and in a public list',
        { fields: { profile: ['ssn'] } },
        () => {
          const both = { v: 'visible-shared' };
          return { ssn: both, others: [{ v: 'first' }, both] };
        },
        { ssn: 'REDACTED', others: [{ v: 'first' }, { v: 'visible-shared' }], n: 2 },
      ],
    ])(
      'a record does not change because a stage read a key: %s, read and then changed',
      async (_what, policy, profile, expected) => {
        // A read after the stage's first write hands out a private copy: every part is a new object.
        // Nothing was put in, so the row is the merge it always was and no place is added to the rule.
        const program = (reads: boolean) =>
          flowChart<S>(
            'A',
            (s) => {
              s.profile = profile();
            },
            'a',
          )
            .addFunction(
              'B',
              (s) => {
                s.z = 1;
                if (reads) s.$getValue('profile');
                s.profile.n = 2;
              },
              'b',
            )
            .build();
        const withRead = await run(program(true), commitValues, policy);
        const without = await run(program(false), commitValues, policy);
        const row = (executor: FlowChartExecutor<never, never>) => {
          const bundle = executor.getSnapshot().commitLog.find((one) => one.stageId === 'b');
          return { overwrite: bundle?.overwrite, updates: bundle?.updates, redactedPaths: bundle?.redactedPaths };
        };

        expect(shown(withRead).profile).toEqual(expected);
        expect(row(withRead)).toEqual(row(without));
        const verbs = withRead.getSnapshot().commitLog.find((one) => one.stageId === 'b')?.trace;
        expect(verbs?.filter((entry) => entry.path === 'profile').map((entry) => entry.verb)).toEqual(['merge']);
      },
    );

    it('KNOWN LIMIT: changed in place and then written again under the same key, the EVENT of that write shows it; the record does not', async () => {
      // A write is searched for what is new in it. An object that was written before and still sits at
      // its place is not new, so what the stage put into it in between is not seen at this write. The
      // search at commit sees it (`memory/selectedObjects.ts`, "what a recorder may still see").
      const chart = start({ token: SECRET })
        .addFunction(
          'B',
          (s) => {
            const row: Record<string, unknown> = { n: 1 };
            s.$setValue('rows', [row]);
            row.owner = s.$getValue('secret'); // in place
            s.$setValue('rows', [row, { n: 2 }]); // `row` is where it was
          },
          'b',
        )
        .build();
      const executor = await run(chart, commitValues);

      const plain = executor.getSnapshot();
      expect(JSON.stringify([plain.commitLog, plain.executionTree, shown(executor)])).not.toContain(SECRET);
      expect((events.get(executor) ?? []).join('')).toContain(SECRET); // the limit, pinned
    });
  });
});
