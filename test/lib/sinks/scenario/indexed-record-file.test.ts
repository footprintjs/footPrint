import { mkdtempSync, read, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import * as sinks from '../../../../src/sinks.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, read: vi.fn(actual.read) };
});

const dir = mkdtempSync(join(tmpdir(), 'fp-indexed-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const address = (logRunId: string, drillPath: string[] = []) => ({ logRunId, drillPath });
const lines = (name: string, payload = '') => [
  { kind: 'opened', address: address(name), at: 0, initialState: { payload } },
  { kind: 'closed', address: address(name), at: 1, outcome: 'completed', commits: 0 },
];
const api = () => (sinks as any).openIndexedRecordFile;

describe('indexed authorized record file', () => {
  it('exports the opt-in Node-only loader', () => {
    expect(api()).toBeTypeOf('function');
  });

  it('reads only an allowed scope after one explicit index preparation', async () => {
    const selected = lines('selected');
    const other = lines('unrelated', 'x'.repeat(200_000));
    const text = [...selected, ...other].map((row) => JSON.stringify(row) + '\n').join('');
    const file = join(dir, 'scopes.jsonl');
    writeFileSync(file, text, { mode: 0o600 });
    const opened = await api()(file, { allowedScopes: [address('selected')] });
    expect(opened.status).toBe('ready');
    try {
      expect(opened.reader.stats.preparationBytes).toBe(Buffer.byteLength(text));
      vi.mocked(read).mockClear();
      const before = opened.reader.stats.scopeBytes;
      const loaded = await opened.reader.readScope(address('selected'));
      expect(loaded.status).toBe('loaded');
      expect(loaded.entries).toEqual(selected);
      expect(opened.reader.stats.scopeBytes - before).toBeLessThan(1000);
      expect(opened.reader.stats.scopeBytes).toBe(loaded.bytesRead);
      // Count the actual Node read requests, independent of the library's reported stats.
      const calls = vi.mocked(read).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls.reduce((bytes, call) => bytes + (call[3] as number), 0)).toBe(loaded.bytesRead);
      const selectedEnd = Buffer.byteLength(selected.map((row) => JSON.stringify(row) + '\n').join(''));
      for (const call of calls) expect((call[4] as number) + (call[3] as number)).toBeLessThanOrEqual(selectedEnd);
    } finally {
      await opened.reader.close();
    }
  });

  it('refuses a scope not explicitly authorized without reading its bytes', async () => {
    const file = join(dir, 'authorization.jsonl');
    writeFileSync(file, [...lines('a'), ...lines('b')].map((row) => JSON.stringify(row) + '\n').join(''));
    const opened = await api()(file, { allowedScopes: [address('a')] });
    try {
      expect(await opened.reader.readScope(address('b'))).toEqual({ status: 'unknown', reason: 'not-permitted' });
      expect(opened.reader.stats.scopeBytes).toBe(0);
    } finally {
      await opened.reader.close();
    }
  });
});
