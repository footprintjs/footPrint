/**
 * `fileSink` — the Node-only file adapter on `footprintjs/sinks` (design §3.5, §4, packet P6).
 *
 * WHY: a record that must survive the process needs somewhere outside it. A JSON-lines file is the smallest such
 * place: one entry per line, each written whole with ONE append before the call returns, so a process killed at
 * any instant leaves every entry it was told about (a torn last line at worst, which the reader names).
 *
 * Test types: Unit (the line format, append, the reader, the size bound, flush, close) · Security (only the path the
 * app gave: a symbolic link there is refused, the file is created owner-only, nothing is read from or written to
 * any other path; a torn line never merges with the next entry) · Boundary (an entry JSON cannot write, a refused
 * entry past the bound, an existing file without a final newline, a reader limit).
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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

describe('fileSink — one JSON line per entry', () => {
  it('writes each entry as it lands, whole, one per line, appended', () => {
    const path = join(dir, 'run.jsonl');
    const sink = fileSink(path);
    const log = new EventLog({ count: 0 }, { sink, address, meta: { runId: 'run-1' } });
    expect(lines(path)).toHaveLength(2); // the opened line, then the empty tail after its newline
    log.note('attempt', { attempt: 1 });
    log.close('ok');
    const written = lines(path);
    expect(written[written.length - 1]).toBe('');
    const parsed = written.slice(0, -1).map((l) => JSON.parse(l));
    expect(parsed.map((e) => e.kind)).toEqual(['opened', 'note', 'closed']);
    expect(parsed[0]).toMatchObject({ address, initialState: { count: 0 }, meta: { runId: 'run-1' } });
    expect(parsed[1]).toMatchObject({ note: 'attempt', data: { attempt: 1 } });
    expect(sink.bytes).toBe(statSync(path).size);
    expect(sink.path).toBe(path);
    sink.close();
  });

  it('appends to an existing record file, so many runs can share one', () => {
    const path = join(dir, 'shared.jsonl');
    const a = fileSink(path);
    new EventLog({}, { sink: a, address: { logRunId: 'a', drillPath: [] } }).close('ok');
    a.close();
    const b = fileSink(path);
    new EventLog({}, { sink: b, address: { logRunId: 'b', drillPath: [] } }).close('ok');
    b.close();
    const record = readStoredRecord(readRecordFile(path).entries);
    expect(record.root('a')?.complete).toBe(true);
    expect(record.root('b')?.complete).toBe(true);
  });

  it('flush() resolves once the file is synced; after close() every method throws (the run counts it)', async () => {
    const sink = fileSink(join(dir, 'f.jsonl'));
    const log = new EventLog({}, { sink, address });
    await expect(sink.flush!()).resolves.toBeUndefined();
    sink.close();
    sink.close(); // idempotent
    log.close('ok');
    expect(log.sinkFailures).toBe(1);
    await expect(sink.flush!()).rejects.toThrow(/closed/);
  });
});

describe('fileSink — bounded', () => {
  it('refuses (never writes) an entry that would pass maxBytes; the closing entry may use the small reserve', () => {
    const path = join(dir, 'bounded.jsonl');
    const sink = fileSink(path, { maxBytes: 400 });
    const log = new EventLog({}, { sink, address });
    for (let i = 0; i < 20; i++) log.note('n', { i, pad: 'x'.repeat(40) });
    expect(log.sinkFailures).toBeGreaterThan(0);
    const before = statSync(path).size;
    expect(before).toBeLessThanOrEqual(400);
    log.close('ok');
    const after = statSync(path).size;
    expect(after).toBeGreaterThan(before); // the close went in, within the reserve
    expect(readStoredRecord(readRecordFile(path).entries).root('run-1')?.notes.length).toBeLessThan(20);
    sink.close();
  });

  it('refuses a maxBytes that is not a positive whole number', () => {
    for (const maxBytes of [0, -1, 1.5, Number.NaN, Infinity]) {
      expect(() => fileSink(join(dir, `m${String(maxBytes)}.jsonl`), { maxBytes })).toThrow(RangeError);
    }
  });

  it('an entry JSON cannot write (a BigInt) is refused whole — counted, nothing written', () => {
    const path = join(dir, 'big.jsonl');
    const sink = fileSink(path);
    const log = new EventLog({}, { sink, address });
    const size = statSync(path).size;
    log.note('n', { big: 10n } as never);
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

  it('refuses a path that is not a regular file (a directory)', () => {
    expect(() => fileSink(dir)).toThrow();
  });

  it('creates the file readable and writable by its owner only', () => {
    if (process.platform === 'win32') return;
    const path = join(dir, 'private.jsonl');
    fileSink(path).close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('an existing file whose last line was torn gets a newline first — the torn line never swallows an entry', () => {
    const path = join(dir, 'torn.jsonl');
    writeFileSync(path, '{"kind":"comm');
    chmodSync(path, 0o600);
    const sink = fileSink(path);
    new EventLog({}, { sink, address }).close('ok');
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
