/**
 * No secret reaches the sink (design §6, the one law): the redaction policy applies before ANY entry is written.
 *
 * WHY: a sink writes to disk, a bucket, a table — places that outlive the process and are read by people the run
 * never met. Every entry the run hands it is a SERVED surface: the `opened` base is the mirror's seed (scrubbed),
 * each commit is the log's own scrubbed bundle, an attempt note carries the served `AttemptRecord`, and the
 * lifecycle meta (correlation, the closing error) is a boundary record handed out whole.
 *
 * Test types: Security (a policy key seeded by `initialContext`, a key written by a stage, a per-call mark, a key
 * inside a subflow, a retried stage whose error carries a selected key, a failing run whose error carries one, a
 * resumed run whose checkpoint holds one) — the secret never appears in any entry, at any depth.
 */
import type { RecordEntry } from 'foottrace/write';
import { memorySink } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import type { PausableHandler } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';

type S = Record<string, any>;

const SECRET = 'hunter2-SECRET';
const TOKEN = 'tok-9f8e7d-SECRET';

/** Every entry, as the bytes a file sink would write. */
const bytes = (entries: readonly RecordEntry[]) => JSON.stringify(entries);

describe('the sink receives only what the run serves', () => {
  it('state: a seeded key, a written key, a marked key and a subflow key are scrubbed in every entry', async () => {
    let tries = 0;
    const inner = flowChart<S>(
      'Inner',
      (s) => {
        s.password = `${SECRET}-inner`;
      },
      'inner',
    ).build();
    const chart = flowChart<S>(
      'Login',
      (s) => {
        s.password = SECRET;
        s.$setValue('sessionToken', TOKEN, true); // a per-call mark
        s.user = 'ada';
      },
      'login',
    )
      .addFunction(
        'Charge',
        () => {
          tries += 1;
          if (tries === 1) throw Object.assign(new Error('declined'), { password: SECRET });
        },
        'charge',
      )
      .retry({ attempts: 2, backoffMs: 0 })
      .addSubFlowChartNext('sf', inner, 'Inner', {
        inputMapper: (p: S) => ({ upstream: p.password }), // a selected read, under another name: tainted
        outputMapper: () => ({}),
      })
      .build();

    const sink = memorySink();
    const executor = new FlowChartExecutor(chart, {
      sink,
      initialContext: { password: `${SECRET}-seed`, apiKey: 'k' },
    });
    executor.setRedactionPolicy({ keys: ['password'] });
    await executor.run();

    const written = bytes(sink.entries);
    expect(written).not.toContain(SECRET);
    expect(written).not.toContain(TOKEN);
    // …and the record is still the record: the scrubbed names are there, as the log's placeholder.
    expect(written).toContain('REDACTED');
    const opened = sink.entries[0] as Extract<RecordEntry, { kind: 'opened' }>;
    expect(opened.initialState).toEqual({ password: 'REDACTED', apiKey: 'k' });
    // The attempt note carries the served error — no raw, no selected key.
    const notes = sink.entries.filter((e) => e.kind === 'note') as Extract<RecordEntry, { kind: 'note' }>[];
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) expect(JSON.stringify(note.data)).not.toContain(SECRET);
  });

  it("a failing run's closing error is the served one", async () => {
    const chart = flowChart<S>(
      'Boom',
      () => {
        throw Object.assign(new Error('could not log in'), { password: SECRET });
      },
      'boom',
    ).build();
    const sink = memorySink();
    const executor = new FlowChartExecutor(chart, { sink });
    executor.setRedactionPolicy({ keys: ['password'] });
    await expect(executor.run()).rejects.toThrow('could not log in');
    expect(bytes(sink.entries)).not.toContain(SECRET);
    const closed = sink.entries[sink.entries.length - 1] as Extract<RecordEntry, { kind: 'closed' }>;
    expect(closed.outcome).toBe('failed');
    expect(Object.keys((closed.meta as any).error).sort()).toEqual(['message', 'name']);
  });

  it('a diagnostic selector masks the closing error text too', async () => {
    const chart = flowChart<S>(
      'Boom',
      () => {
        throw new Error(`card ${SECRET} declined`);
      },
      'boom',
    ).build();
    const sink = memorySink();
    const executor = new FlowChartExecutor(chart, { sink });
    executor.setRedactionPolicy({ diagnostics: { keys: ['errors.stageExecutionError'] } });
    await expect(executor.run()).rejects.toThrow();
    expect(bytes(sink.entries)).not.toContain(SECRET);
  });

  it("a fresh-executor resume opens with the checkpoint's state scrubbed (marks carried by the checkpoint too)", async () => {
    const chart = flowChart<S>(
      'Receive',
      (s) => {
        s.password = SECRET;
        s.$setValue('sessionToken', TOKEN, true);
      },
      'receive',
    )
      .addPausableFunction(
        'Approve',
        {
          execute: async () => ({ question: 'ok?' }),
          resume: async (s: S) => {
            s.approved = true;
          },
        } as PausableHandler<S, unknown>,
        'approve',
      )
      .build();
    const first = new FlowChartExecutor(chart);
    first.setRedactionPolicy({ keys: ['password'] });
    await first.run();

    const sink = memorySink();
    const second = new FlowChartExecutor(chart, { sink });
    second.setRedactionPolicy({ keys: ['password'] });
    await second.resume(first.getCheckpoint()!, {});
    expect(bytes(sink.entries)).not.toContain(SECRET);
    expect(bytes(sink.entries)).not.toContain(TOKEN);
  });

  it("the correlation rides the opened meta as the run's own frozen object's copy — never the raw header bytes", async () => {
    const header = `00-${'4bf92f3577b34da6a3ce929d0e0e4736'}-${'00f067aa0ba902b7'}-01`;
    const chart = flowChart<S>(
      'One',
      (s) => {
        s.x = 1;
      },
      'one',
    ).build();
    const sink = memorySink();
    const executor = new FlowChartExecutor(chart, { sink });
    await executor.run({ env: { traceparent: header } });
    const opened = sink.entries[0] as Extract<RecordEntry, { kind: 'opened' }>;
    expect((opened.meta as any).correlation).toEqual(executor.getSnapshot().correlation);
  });
});
