/**
 * `fileSink` — the Node-only file adapter on `footprintjs/sinks` (design §3.5, §4, packet P6).
 *
 * WHY: a record that must survive the process needs somewhere outside it. A JSON-lines file is the smallest such
 * place: one entry per line, queued and appended asynchronously in order, each line whole — and every resource the
 * sink spends is bounded, so a slow, full or broken disk never stalls or grows the run.
 *
 * Test types: Unit (the line format, append, async writes, the reader, flush, close) · Boundary (every bound:
 * `maxEntryBytes`, `maxQueuedBytes`, `maxBytes` then full, `flushTimeoutMs`; an entry JSON cannot write; an existing
 * file without a final newline) · Security (only the path the app gave: a symbolic link, a hard link, a foreign or
 * shared-writable file refused; created owner-only; a torn line never merges with the next entry).
 */
import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readStoredRecord } from 'foottrace';
import { EventLog } from 'foottrace/write';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { fileSink, readRecordFile } from '../../../../src/sinks.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fp-sink-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const address = { logRunId: 'run-1', drillPath: [] as string[] };
const lines = (path: string) => readFileSync(path, 'utf8').split('\n');
/** Let a log's watched promises settle (the log counts a rejected entry when it settles). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('fileSink — one JSON line per entry, written asynchronously', () => {
  it('queues each entry at once and appends it in order — whole, one per line', async () => {
    const path = join(dir, 'run.jsonl');
    const sink = fileSink(path);
    const log = new EventLog({ count: 0 }, { sink, address, meta: { runId: 'run-1' } });
    log.note('attempt', { attempt: 1 });
    log.close('ok');
    await sink.flush!();
    const written = lines(path);
    expect(written[written.length - 1]).toBe('');
    const parsed = written.slice(0, -1).map((l) => JSON.parse(l));
    expect(parsed.map((e) => e.kind)).toEqual(['opened', 'note', 'closed']);
    expect(parsed[0]).toMatchObject({ address, initialState: { count: 0 }, meta: { runId: 'run-1' } });
    expect(parsed[1]).toMatchObject({ note: 'attempt', data: { attempt: 1 } });
    expect(sink.bytes).toBe(statSync(path).size);
    expect(sink.queuedBytes).toBe(0);
    expect(sink.path).toBe(path);
    sink.close();
  });

  it('no method writes synchronously: the call returns with the line queued, its promise settles once written', async () => {
    const path = join(dir, 'async.jsonl');
    const sink = fileSink(path);
    const returned = sink.note({ address, at: 1, kind: 'n', data: { i: 1 } });
    // The call returned with the line still the sink's (its completion is reported on the event loop, later).
    expect(returned).toBeInstanceOf(Promise);
    expect(sink.queuedBytes).toBeGreaterThan(0);
    await returned;
    expect(statSync(path).size).toBeGreaterThan(0);
    sink.close();
  });

  it('appends to an existing record file, so many runs can share one (one writer at a time)', async () => {
    const path = join(dir, 'shared.jsonl');
    const a = fileSink(path);
    new EventLog({}, { sink: a, address: { logRunId: 'a', drillPath: [] } }).close('ok');
    await a.flush!();
    a.close();
    const b = fileSink(path);
    new EventLog({}, { sink: b, address: { logRunId: 'b', drillPath: [] } }).close('ok');
    await b.flush!();
    b.close();
    const record = readStoredRecord(readRecordFile(path).entries);
    expect(record.root('a')?.complete).toBe(true);
    expect(record.root('b')?.complete).toBe(true);
  });

  it('close() refuses new entries (the run counts them) and still writes what it accepted; flush() then rejects', async () => {
    const path = join(dir, 'f.jsonl');
    const sink = fileSink(path);
    const log = new EventLog({}, { sink, address });
    sink.close();
    sink.close(); // idempotent
    log.close('ok');
    expect(log.sinkFailures).toBe(1);
    await expect(sink.flush!()).rejects.toThrow(/closed/);
    await settle();
    expect(readRecordFile(path).entries).toHaveLength(1); // the opened entry, accepted before close
  });
});

describe('fileSink — every bound, each refusal named and counted', () => {
  it('maxEntryBytes: one entry larger than the bound is refused whole, by name; smaller ones still go', async () => {
    const path = join(dir, 'entry.jsonl');
    const sink = fileSink(path, { maxEntryBytes: 300 });
    let lastError = '';
    const log = new EventLog({}, { sink: { ...sink, onFailure: ({ error }) => (lastError = String(error)) }, address });
    log.note('big', { pad: 'x'.repeat(1000) });
    log.note('small', { ok: true });
    await sink.flush!();
    expect(log.sinkFailures).toBe(1);
    expect(lastError).toMatch(/maxEntryBytes/);
    expect(
      readStoredRecord(readRecordFile(path).entries)
        .root('run-1')
        ?.notes.map((n) => n.kind),
    ).toEqual(['small']);
    sink.close();
  });

  it('maxQueuedBytes: past the bound an entry is dropped and counted — memory never grows without limit', async () => {
    const path = join(dir, 'queue.jsonl');
    const sink = fileSink(path, { maxQueuedBytes: 2_000 });
    let lastError = '';
    const log = new EventLog({}, { sink: { ...sink, onFailure: ({ error }) => (lastError = String(error)) }, address });
    for (let i = 0; i < 200; i++) log.note('n', { i, pad: 'x'.repeat(100) }); // synchronously: faster than any disk
    expect(sink.queuedBytes).toBeLessThanOrEqual(2_000);
    expect(log.sinkFailures).toBeGreaterThan(0);
    expect(lastError).toMatch(/maxQueuedBytes/);
    await sink.flush!();
    const kept = readStoredRecord(readRecordFile(path).entries).root('run-1')!.notes.length;
    expect(kept + log.sinkFailures).toBe(200); // every entry either written or counted
    sink.close();
  });

  it('maxBytes: once full, every further entry is refused and counted; a closing entry may use the reserve', async () => {
    const path = join(dir, 'bounded.jsonl');
    const sink = fileSink(path, { maxBytes: 400 });
    const log = new EventLog({}, { sink, address });
    for (let i = 0; i < 20; i++) log.note('n', { i, pad: 'x'.repeat(40) });
    expect(sink.full).toBe(true);
    const refused = log.sinkFailures;
    expect(refused).toBeGreaterThan(0);
    log.note('tiny', {}); // would fit — but the file is full: refused too
    expect(log.sinkFailures).toBe(refused + 1);
    await sink.flush!();
    const before = statSync(path).size;
    expect(before).toBeLessThanOrEqual(400);
    log.close('ok');
    await sink.flush!();
    expect(statSync(path).size).toBeGreaterThan(before); // the close went in, within the reserve
    expect(readStoredRecord(readRecordFile(path).entries).root('run-1')?.complete).toBe(true);
    sink.close();
  });

  it('flushTimeoutMs: a flush that cannot finish in time rejects, naming the bound — nothing waits forever', async () => {
    const path = join(dir, 'slow.jsonl');
    const sink = fileSink(path, { flushTimeoutMs: 1, maxQueuedBytes: 64 * 1024 * 1024 });
    const log = new EventLog({}, { sink, address });
    const pad = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 400; i++) log.note('n', { i, pad }); // ~26 MB queued: no disk drains it in 1 ms
    await expect(sink.flush!()).rejects.toThrow(/did not finish in 1ms/);
    sink.close();
    await settle();
  });

  it('refuses a bound that is not a whole number in range', () => {
    for (const maxBytes of [0, -1, 1.5, Number.NaN, Infinity]) {
      expect(() => fileSink(join(dir, `m${String(maxBytes)}.jsonl`), { maxBytes })).toThrow(RangeError);
    }
    expect(() => fileSink(join(dir, 'e.jsonl'), { maxEntryBytes: 0 })).toThrow(/maxEntryBytes/);
    expect(() => fileSink(join(dir, 'q.jsonl'), { maxQueuedBytes: -5 })).toThrow(/maxQueuedBytes/);
    expect(() => fileSink(join(dir, 't.jsonl'), { flushTimeoutMs: -1 })).toThrow(/flushTimeoutMs/);
  });

  it('an entry JSON cannot write (a BigInt) is refused whole — counted, nothing written', async () => {
    const path = join(dir, 'big.jsonl');
    const sink = fileSink(path);
    const log = new EventLog({}, { sink, address });
    await sink.flush!();
    const size = statSync(path).size;
    log.note('n', { big: 10n } as never);
    await sink.flush!();
    expect(log.sinkFailures).toBe(1);
    expect(statSync(path).size).toBe(size);
    sink.close();
  });
});

describe('fileSink — only the path the app gives', () => {
  it('refuses a path that is not a non-empty string', () => {
    for (const bad of ['', 3, undefined, null, {}]) expect(() => fileSink(bad as never)).toThrow(TypeError);
  });

  it('refuses a symbolic link at the path — it never writes through one', () => {
    const target = join(dir, 'elsewhere.txt');
    writeFileSync(target, 'untouched\n');
    const link = join(dir, 'link.jsonl');
    symlinkSync(target, link);
    expect(() => fileSink(link)).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('untouched\n');
  });

  it('refuses a file with another hard link — it never appends into someone else’s bytes', () => {
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'untouched\n');
    chmodSync(victim, 0o600);
    const link = join(dir, 'hard.jsonl');
    linkSync(victim, link);
    expect(() => fileSink(link)).toThrow(/hard links/);
    expect(readFileSync(victim, 'utf8')).toBe('untouched\n');
  });

  it('refuses an existing file others may write', () => {
    if (process.platform === 'win32') return;
    const path = join(dir, 'open.jsonl');
    writeFileSync(path, '');
    chmodSync(path, 0o666);
    expect(() => fileSink(path)).toThrow(/writable by others/);
  });

  it('readRecordFile refuses what is not a regular file', () => {
    expect(() => readRecordFile(dir)).toThrow();
  });

  it('refuses a path that is not a regular file (a directory)', () => {
    expect(() => fileSink(dir)).toThrow();
  });

  it('creates the file readable and writable by its owner only', () => {
    if (process.platform === 'win32') return;
    const path = join(dir, 'private.jsonl');
    fileSink(path).close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('an existing file whose last line was torn gets a newline first — the torn line never swallows an entry', async () => {
    const path = join(dir, 'torn.jsonl');
    writeFileSync(path, '{"kind":"comm');
    chmodSync(path, 0o600);
    const sink = fileSink(path);
    new EventLog({}, { sink, address }).close('ok');
    await sink.flush!();
    sink.close();
    const read = readRecordFile(path);
    expect(read.unreadable).toEqual([{ line: 1, reason: expect.stringContaining('not JSON') }]);
    expect(readStoredRecord(read.entries).root('run-1')?.complete).toBe(true);
  });
});

describe('readRecordFile — the file read back, every line accounted for', () => {
  it('names a torn or corrupt line by number instead of failing the read', () => {
    const path = join(dir, 'mixed.jsonl');
    writeFileSync(path, '{"kind":"note"}\nnot json\n\n{"a":1}\n{"trunc');
    const read = readRecordFile(path);
    expect(read.entries).toEqual([{ kind: 'note' }, { a: 1 }]);
    expect(read.unreadable.map((u) => u.line)).toEqual([2, 5]);
  });

  it('refuses a file larger than its maxBytes before reading it', () => {
    const path = join(dir, 'large.jsonl');
    writeFileSync(path, 'x'.repeat(2000));
    expect(() => readRecordFile(path, { maxBytes: 1000 })).toThrow(RangeError);
  });

  it('a stored key named __proto__ stays data, never a prototype', () => {
    const path = join(dir, 'proto.jsonl');
    writeFileSync(path, '{"__proto__":{"polluted":true}}\n');
    const [entry] = readRecordFile(path).entries as Record<string, unknown>[];
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(entry)).toBe(Object.prototype);
  });
});

describe('fileSink on a real run', () => {
  it('the stored record reads back as the run', async () => {
    const path = join(dir, 'run.jsonl');
    const chart = flowChart<Record<string, any>>(
      'Seed',
      (s) => {
        s.n = 1;
      },
      'seed',
    )
      .addFunction(
        'Grow',
        (s) => {
          s.n = s.n + 1;
        },
        'grow',
      )
      .build();
    const sink = fileSink(path);
    const executor = new FlowChartExecutor(chart, { sink });
    await executor.run();
    sink.close();
    const snapshot = executor.getSnapshot();
    const root = readStoredRecord(readRecordFile(path).entries).root(snapshot.runId)!;
    expect(root.complete).toBe(true);
    expect(root.commitLog).toHaveLength(snapshot.commitLog.length);
    expect(executor.getSnapshot().sink).toEqual({ entries: 4, failed: 0 });
  });
});
