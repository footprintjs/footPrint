import { fstatSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type LogAddress, readStoredRecord, stateAt } from 'foottrace';
import { expect, it, vi } from 'vitest';

import { openIndexedRecordFile, openPublishedRecordFile } from '../../../src/sinks.js';
import { capture } from './fixture.js';

type Read = { ino: number; offset: number; requested: number; returned: number };
const reads = vi.hoisted(() => [] as Read[]);

// Follow the scenario suite's node:fs seam. Capture the descriptor at submission
// (the OS may reuse it after close), and bytes on completion, including short reads.
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    read(
      fd: number,
      buf: Uint8Array,
      pos: number,
      len: number,
      offset: number,
      callback: (error: Error | null, bytes: number, buffer: Uint8Array) => void,
    ) {
      const call = { ino: fstatSync(fd).ino, offset, requested: len, returned: 0 };
      reads.push(call);
      return fs.read(fd, buf, pos, len, offset, (error, bytes, buffer) => {
        call.returned = bytes;
        callback(error, bytes, buffer);
      });
    },
  };
});

async function measure(record: Awaited<ReturnType<typeof capture>>) {
  const { payload, sidecar, publication, rows } = record;
  const opening = rows.find(({ row }) => row.kind === 'opened' && row.address.drillPath.length === 0)?.row;
  if (!opening || opening.kind !== 'opened') throw new Error('Missing root opening');
  expect(opening.initialState).toHaveProperty('privateLabel');
  const root = opening.address;
  const children = rows.filter(({ row }) => row.kind === 'opened' && row.address.drillPath.length > 0);
  expect(children).toHaveLength(8);
  const child = children[0].row.address;
  const parallelChild = children[2].row.address;
  const repeat = children[4].row.address;
  expect(repeat.drillPath).not.toEqual(child.drillPath);
  const same = (a: LogAddress, b: LogAddress) =>
    a.logRunId === b.logRunId && JSON.stringify(a.drillPath) === JSON.stringify(b.drillPath);
  const rootRows = rows.filter(({ row }) => same(row.address, root));
  const childRows = rows.filter(({ row }) => same(row.address, child));
  const parallelRows = rows.filter(({ row }) => same(row.address, parallelChild));
  const log = readStoredRecord(rows.map(({ row }) => row)).log(root);
  if (!log?.complete) throw new Error('Expected complete reference recording');
  const dataFile = statSync(payload);
  const indexFile = statSync(sidecar);
  const options = { audience: 'scheduler', allowedScopes: [root, child, parallelChild, repeat] };
  const report: { phase: string; calls: number; bytes: number; repeatedBytes: number }[] = [];
  const publicResults: unknown[] = [];
  function phase(name: string, ino: number, allowed: { start: number; end: number }[], prior: Read[] = []) {
    const spans = reads.splice(0);
    // A cached selection may complete without submitting a physical read.
    let repeatedBytes = 0;
    for (const call of spans) {
      expect(call.ino, name).toBe(ino);
      const end = call.offset + call.requested;
      const accepted = allowed.reduce(
        (n, span) => n + Math.max(0, Math.min(end, span.end) - Math.max(call.offset, span.start)),
        0,
      );
      expect(accepted, name).toBe(call.requested);
      const returnedEnd = call.offset + call.returned;
      let cursor = call.offset;
      for (const old of [...prior].sort((a, b) => a.offset - b.offset)) {
        const start = Math.max(cursor, old.offset);
        const overlappingEnd = Math.min(returnedEnd, old.offset + old.returned);
        if (start < overlappingEnd) {
          repeatedBytes += overlappingEnd - start;
          cursor = overlappingEnd;
        }
      }
    }
    report.push({
      phase: name,
      calls: spans.length,
      bytes: spans.reduce((n, call) => n + call.returned, 0),
      repeatedBytes,
    });
    return spans;
  }

  reads.length = 0;
  const legacy = await openIndexedRecordFile(payload, { allowedScopes: options.allowedScopes });
  if (legacy.status !== 'ready') throw new Error(legacy.reason);
  try {
    phase('legacy open', dataFile.ino, [{ start: 0, end: dataFile.size }]);
    expect(report[0].bytes).toBe(dataFile.size);
  } finally {
    await legacy.reader.close();
  }

  const open = async () => {
    const result = await openPublishedRecordFile(payload, sidecar, publication, options);
    if (result.status !== 'ready') throw new Error(result.reason);
    const { diagnostics } = result;
    const first = report.length;
    function checkCounters() {
      const [index, ...payloadReads] = report.slice(first);
      expect(diagnostics.stats).toEqual({
        preparationBytes: index.bytes,
        scopeBytes: payloadReads.reduce((total, p) => total + p.bytes, 0),
        readCalls: payloadReads.reduce((total, p) => total + p.calls, 0),
      });
    }
    return { reader: result.reader, checkCounters };
  };
  const { reader, checkCounters } = await open();
  try {
    phase('index open', indexFile.ino, [{ start: 0, end: indexFile.size }]);
    expect(report.at(-1)?.bytes).toBe(indexFile.size);
    checkCounters();
    const denied = await reader.readScope(children[3].row.address);
    expect(denied).toMatchObject({ status: 'unknown', reason: 'not-permitted' });
    phase('unselected sibling', dataFile.ino, []);
    expect(report.at(-1)?.calls).toBe(0);
    checkCounters();
    publicResults.push(denied);
    for (const [name, addr, owned] of [
      ['root', root, rootRows],
      ['child', child, childRows],
      ['parallel child', parallelChild, parallelRows],
      ['repeated mount', repeat, rows.filter(({ row }) => same(row.address, repeat))],
    ] as const) {
      const view = await reader.readScope(addr);
      if (view.status !== 'loaded') throw new Error(view.reason);
      phase(name, dataFile.ino, owned);
      expect(view.coverage).toBe('whole');
      expect(view.entries).toEqual(owned.map(({ row }) => row));
      expect(view).not.toHaveProperty('bytesRead');
      checkCounters();
      publicResults.push(view);
    }
  } finally {
    await reader.close();
  }

  const { reader: cold, checkCounters: checkColdCounters } = await open();
  try {
    phase('cold index open', indexFile.ino, [{ start: 0, end: indexFile.size }]);
    checkColdCounters();
    const middle = rootRows.find(({ row }) => row.kind === 'commit' && row.bundle.stageId === 'midpoint');
    const midpoint = middle?.row.kind === 'commit' ? middle.row.bundle.idx : undefined;
    if (midpoint === undefined) throw new Error('Missing recorded midpoint index');
    let previous: Read[] = [];
    for (const [name, target] of [
      ['cold seek', midpoint],
      ['next step', midpoint + 1],
    ] as const) {
      const view = await cold.readState(root, target);
      if (view.status !== 'loaded') throw new Error(view.reason);
      const commit = rootRows.findIndex(({ row }) => row.kind === 'commit' && row.bundle.idx === target);
      expect(commit).toBeGreaterThanOrEqual(0);
      // The writer may pack later rows into the range containing the target.
      // The next disjoint stretch of root rows, beyond a child, cannot belong to it.
      let last = commit;
      while (last + 1 < rootRows.length && rootRows[last].end === rootRows[last + 1].start) last++;
      previous = phase(name, dataFile.ino, rootRows.slice(0, last + 1), previous);
      expect(view.state).toEqual(stateAt(log.source(), target));
      expect(view.coverage).toBe('prefix');
      expect(view).not.toHaveProperty('bytesRead');
      checkColdCounters();
      publicResults.push(view);
    }
  } finally {
    await cold.close();
  }
  return { report, publicBytes: JSON.stringify(publicResults) };
}

it.each(['full', 'delta'] as const)('measures native scope and seek I/O with %s capture', async (encoding) => {
  const dirs = Array.from({ length: 3 }, () => mkdtempSync(join(tmpdir(), 'fp-p5-')));
  try {
    const left = await measure(await capture(dirs[0], encoding, 'first shift'));
    const right = await measure(await capture(dirs[1], encoding, 'second, longer shift'));
    expect(left.publicBytes).not.toContain('first shift');
    expect(right.publicBytes).not.toContain('second, longer shift');
    expect(left.publicBytes).toBe(right.publicBytes);
    expect(left.report).toEqual(right.report);
    const split = await measure(await capture(dirs[2], encoding, 'second, longer shift', true));
    expect(split.publicBytes).toBe(right.publicBytes);
    const rootCalls = (result: typeof split) => {
      const root = result.report.find((p) => p.phase === 'root');
      if (!root) throw new Error('Missing root measurement');
      return root.calls;
    };
    expect(rootCalls(split)).toBeGreaterThan(rootCalls(right));
    console.info('Interleaved recording I/O', JSON.stringify({ encoding, operations: split.report }));
    console.info('Published recording I/O', JSON.stringify({ encoding, operations: left.report }));
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});
