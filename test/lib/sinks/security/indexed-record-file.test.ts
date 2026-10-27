import { appendFileSync, chmodSync, fstatSync, linkSync, openSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openIndexedRecordFile } from '../../../../src/sinks.js';
import {
  indexedAddress,
  indexedFixture,
  indexedReady,
  indexedRows,
  indexedText,
} from '../../../helpers/indexedRecordFile.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, fstatSync: vi.fn(actual.fstatSync), openSync: vi.fn(actual.openSync) };
});
const dirs: string[] = [];
const fixture = (rows?: unknown[]) => {
  const file = indexedFixture(rows);
  dirs.push(file.dir);
  return file;
};
afterEach(() => {
  vi.mocked(fstatSync).mockRestore();
  vi.mocked(openSync).mockClear();
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe('indexed record authorization and immutable evidence', () => {
  it.each(['hidden getter', 'hidden unknown field', 'symbol data', 'symbol getter'])(
    'rejects a %s host option before opening without executing it',
    async (kind) => {
      const file = fixture();
      let calls = 0;
      const options = { allowedScopes: [indexedAddress()] };
      const key = kind.startsWith('symbol')
        ? Symbol('private-option')
        : kind === 'hidden getter'
        ? 'maxBytes'
        : 'unknown';
      Object.defineProperty(
        options,
        key,
        kind.endsWith('getter')
          ? {
              get() {
                calls++;
                throw Error('PRIVATE');
              },
            }
          : { value: true },
      );
      let refused: unknown;
      try {
        const result = await openIndexedRecordFile(file.path, options);
        // The v1 red witness must release any reader it incorrectly accepts.
        if (result.status === 'ready') await result.reader.close();
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(TypeError);
      expect(openSync).not.toHaveBeenCalled();
      expect(calls).toBe(0);
    },
  );

  it('honors a supported non-enumerable own data limit', async () => {
    const file = fixture();
    const options = { allowedScopes: [indexedAddress()] };
    Object.defineProperty(options, 'maxBytes', { value: 1 });
    expect(await openIndexedRecordFile(file.path, options)).toEqual({ status: 'unknown', reason: 'too-large' });
  });

  it('requires an explicit scope allowlist instead of trusting the file index', async () => {
    const file = fixture();
    await expect(openIndexedRecordFile(file.path, {} as any)).rejects.toThrow('explicit host authorization');
    await expect(
      openIndexedRecordFile(file.path, Object.create({ allowedScopes: [indexedAddress()] })),
    ).rejects.toThrow();
  });

  it('does not execute authorization or option accessors', async () => {
    const file = fixture();
    let calls = 0;
    const options = Object.defineProperty({}, 'allowedScopes', {
      enumerable: true,
      get() {
        calls++;
        throw Error('PRIVATE');
      },
    });
    await expect(openIndexedRecordFile(file.path, options as any)).rejects.toThrow('plain data');
    expect(calls).toBe(0);
  });

  it('detaches the host authorization list before preparing the index', async () => {
    const file = fixture([...indexedRows(), ...indexedRows('other')]);
    const scope = { logRunId: 'one', drillPath: [] as string[] };
    const allowedScopes = [scope];
    const opened = await openIndexedRecordFile(file.path, { allowedScopes });
    if (opened.status !== 'ready') throw Error('fixture');
    scope.logRunId = 'other';
    allowedScopes.push(indexedAddress('other'));
    try {
      expect((await opened.reader.readScope(indexedAddress())).status).toBe('loaded');
      expect(await opened.reader.readScope(indexedAddress('other'))).toEqual({
        status: 'unknown',
        reason: 'not-permitted',
      });
    } finally {
      await opened.reader.close();
    }
  });

  it('refuses requested-address and cancellation accessors without calling them', async () => {
    const file = fixture();
    const reader = await indexedReady(file.path);
    let calls = 0;
    const hostile = Object.defineProperty({ drillPath: [] }, 'logRunId', {
      get() {
        calls++;
        throw Error('PRIVATE');
      },
    });
    const context = Object.defineProperty({}, 'signal', {
      get() {
        calls++;
        throw Error('PRIVATE');
      },
    });
    try {
      expect(await reader.readScope(hostile as any)).toEqual({ status: 'unknown', reason: 'invalid-data' });
      expect(await reader.readScope(indexedAddress(), context)).toEqual({ status: 'unknown', reason: 'invalid-data' });
      expect(calls).toBe(0);
      expect(reader.stats.scopeBytes).toBe(0);
    } finally {
      await reader.close();
    }
  });

  it.each(['symlink', 'hardlink', 'shared writable', 'directory'])(
    'refuses an unsafe %s without private error text',
    async (kind) => {
      const file = fixture();
      let path = file.path;
      if (kind === 'symlink') {
        path = join(file.dir, 'symlink');
        symlinkSync(file.path, path);
      }
      if (kind === 'hardlink') linkSync(file.path, join(file.dir, 'hardlink'));
      if (kind === 'shared writable') chmodSync(file.path, 0o666);
      if (kind === 'directory') path = file.dir;
      expect(await openIndexedRecordFile(path, { allowedScopes: [indexedAddress()] })).toEqual({
        status: 'unknown',
        reason: 'unavailable',
      });
    },
  );

  it.each(['append', 'overwrite'])('refuses %s mutation before scope reads', async (kind) => {
    const file = fixture();
    const reader = await indexedReady(file.path);
    if (kind === 'append') appendFileSync(file.path, '\n');
    else writeFileSync(file.path, indexedText(indexedRows('two')));
    try {
      expect(await reader.readScope(indexedAddress())).toEqual({ status: 'unknown', reason: 'stale' });
      expect(reader.stats.scopeBytes).toBe(0);
    } finally {
      await reader.close();
    }
  });

  it('checks each selected range digest even if metadata is made to look unchanged', async () => {
    const file = fixture();
    const original = vi.mocked(fstatSync).getMockImplementation()!;
    let saved: any;
    vi.mocked(fstatSync).mockImplementation(((fd: number) => {
      saved = original(fd);
      return saved;
    }) as any);
    const reader = await indexedReady(file.path);
    vi.mocked(fstatSync).mockImplementation(() => saved);
    writeFileSync(file.path, indexedText(indexedRows('two')));
    try {
      expect(await reader.readScope(indexedAddress())).toEqual({ status: 'unknown', reason: 'stale' });
      expect(reader.stats.scopeBytes).toBeGreaterThan(0);
    } finally {
      await reader.close();
    }
  });

  it('keeps delimiter-like names and inherited-property names as literal address data', async () => {
    const file = fixture([...indexedRows('__proto__', ['a/b']), ...indexedRows('__proto__', ['a', 'b'])]);
    const reader = await indexedReady(file.path, [indexedAddress('__proto__', ['a/b'])]);
    try {
      expect((await reader.readScope(indexedAddress('__proto__', ['a/b']))).status).toBe('loaded');
      expect(await reader.readScope(indexedAddress('__proto__', ['a', 'b']))).toEqual({
        status: 'unknown',
        reason: 'not-permitted',
      });
      expect({}.constructor).toBe(Object);
    } finally {
      await reader.close();
    }
  });

  it.each([
    'null\n',
    '{bad json}\n',
    '{"address":{"logRunId":"one","drillPath":[]}}',
    '{"address":{"logRunId":"one","drillPath":[null]}}\n',
  ])('never silently drops malformed/torn input %s', async (text) => {
    const file = fixture();
    writeFileSync(file.path, text);
    expect(await openIndexedRecordFile(file.path, { allowedScopes: [indexedAddress()] })).toEqual({
      status: 'unknown',
      reason: 'invalid-data',
    });
  });
});
