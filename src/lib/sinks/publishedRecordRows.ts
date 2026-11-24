import type { RecordEntry } from 'foottrace/write';

import { ownData } from '../capture/noteShape.js';
import { checkSignal, indexedAddress, IndexedRefusal, indexedText } from './indexedAdmission.js';
import { digest, readBytes } from './indexedIO.js';
import type { IndexedLimits } from './indexedTypes.js';
import type { PublishedRecordRange } from './publishedRecordWriter.js';

type WrittenRange = Extract<PublishedRecordRange, { status: 'written' }>;
export type PublishedOmission = {
  readonly id: number;
  readonly reason: 'too-large' | 'unavailable' | 'invalid-data' | 'stale';
};

const MAX_NODES = 200000;
const MAX_DEPTH = 100;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function index(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function admitRow(value: unknown, scope: string): RecordEntry {
  if (
    !isObject(value) ||
    indexedAddress(ownData(value, 'address')) !== scope ||
    typeof value.at !== 'number' ||
    !Number.isFinite(value.at)
  )
    throw new IndexedRefusal('invalid-data');
  switch (value.kind) {
    case 'opened':
      if (isObject(value.initialState)) return value as unknown as RecordEntry;
      break;
    case 'commit':
      if (isObject(value.bundle) && index(value.bundle.idx)) return value as unknown as RecordEntry;
      break;
    case 'note':
      if (typeof value.note === 'string' && isObject(value.data)) return value as unknown as RecordEntry;
      break;
    case 'closed':
      if (index(value.commits) && (value.outcome === 'ok' || value.outcome === 'failed' || value.outcome === 'paused'))
        return value as unknown as RecordEntry;
      break;
  }
  throw new IndexedRefusal('invalid-data');
}

function spendNode(budget: { left: number }, depth: number): void {
  if (--budget.left < 0 || depth > MAX_DEPTH) throw new IndexedRefusal('too-large');
}

function endOfString(text: string, start: number): number {
  for (let offset = start + 1; offset < text.length; offset++) {
    if (text[offset] === '\\') offset++;
    else if (text[offset] === '"') return offset;
  }
  throw new IndexedRefusal('invalid-data');
}

/**
 * Charge the root, each object value and each array element before allocating decoded rows.
 * Strings are opaque here. JSON.parse still owns JSON syntax and decoding.
 */
function checkJsonWork(text: string, budget: { left: number }): void {
  const containers: ('{' | '[')[] = [];
  spendNode(budget, 0);
  for (let offset = 0; offset < text.length; offset++) {
    const char = text[offset];
    if (char === '"') offset = endOfString(text, offset);
    else if (char === '{' || char === '[') {
      if (containers.length > MAX_DEPTH) throw new IndexedRefusal('too-large');
      containers.push(char);
      if (char === '[') {
        let start = offset + 1;
        while (start < text.length && /[ \t\r\n]/.test(text[start])) start++;
        if (text[start] !== ']') spendNode(budget, containers.length);
        offset = start - 1;
      }
    } else if (char === '}' || char === ']') containers.pop();
    else if (char === ':' || (char === ',' && containers.at(-1) === '[')) spendNode(budget, containers.length);
  }
}

export function planOmissions(
  ranges: readonly PublishedRecordRange[],
  limits: IndexedLimits,
): readonly PublishedOmission[] {
  const omissions: PublishedOmission[] = [];
  let bytes = 0;
  let rows = 0;
  for (const range of ranges) {
    if (range.status === 'omitted') {
      omissions.push({ id: range.id, reason: range.reason });
      continue;
    }
    bytes += range.bytes;
    rows += range.rowCount;
    if (range.maxLineBytes > limits.maxEntryBytes || bytes > limits.maxScopeBytes || rows > limits.maxEntries)
      omissions.push({ id: range.id, reason: 'too-large' });
  }
  return omissions;
}

async function readRange(
  fd: number,
  scope: string,
  range: WrittenRange,
  maxEntryBytes: number,
  signal: AbortSignal,
  count: (bytes: number) => void,
  submitted: () => void,
  budget: { left: number },
): Promise<readonly RecordEntry[]> {
  if (range.maxLineBytes > maxEntryBytes || range.rowCount > budget.left) throw new IndexedRefusal('too-large');
  const bytes = await readBytes(fd, range.offset, range.bytes, signal, count, submitted);
  if (digest(bytes) !== range.digest) throw new IndexedRefusal('stale');
  const rows: RecordEntry[] = [];
  let firstCommit: number | undefined;
  let lastCommit: number | undefined;
  let closedThrough: number | undefined;
  let maxLineBytes = 0;
  for (let start = 0; start < bytes.length; ) {
    checkSignal(signal);
    const end = bytes.indexOf(10, start);
    if (end < 0 || end === start || rows.length >= range.rowCount || closedThrough !== undefined)
      throw new IndexedRefusal('invalid-data');
    const lineBytes = end + 1 - start;
    if (lineBytes > maxEntryBytes) throw new IndexedRefusal('too-large');
    if (lineBytes > range.maxLineBytes) throw new IndexedRefusal('invalid-data');
    maxLineBytes = Math.max(maxLineBytes, lineBytes);
    const text = indexedText(bytes.subarray(start, end));
    checkJsonWork(text, budget);
    const row = admitRow(JSON.parse(text), scope);
    if (row.kind === 'commit') {
      const position = row.bundle.idx;
      if (!index(position)) throw new IndexedRefusal('invalid-data');
      firstCommit = Math.min(firstCommit ?? position, position);
      lastCommit = Math.max(lastCommit ?? position, position);
    } else if (row.kind === 'closed') {
      closedThrough = row.commits - 1;
    }
    rows.push(row);
    start = end + 1;
  }
  if (
    rows.length !== range.rowCount ||
    maxLineBytes !== range.maxLineBytes ||
    firstCommit !== range.firstCommit ||
    lastCommit !== range.lastCommit ||
    closedThrough !== range.closedThrough
  )
    throw new IndexedRefusal('invalid-data');
  return rows;
}

export async function readPublishedRows(
  fd: number,
  scope: string,
  ranges: readonly PublishedRecordRange[],
  maxEntryBytes: number,
  signal: AbortSignal,
  count: (bytes: number) => void,
  submitted: () => void,
): Promise<
  | { readonly status: 'loaded'; readonly rows: readonly RecordEntry[]; readonly bytesRead: number }
  | { readonly status: 'omitted'; readonly omitted: PublishedOmission }
> {
  const rows: RecordEntry[] = [];
  let bytesRead = 0;
  const budget = { left: MAX_NODES };
  for (const range of ranges) {
    if (range.status !== 'written') throw new IndexedRefusal('invalid-data');
    try {
      const part = await readRange(fd, scope, range, maxEntryBytes, signal, count, submitted, budget);
      for (const row of part) rows.push(row);
      bytesRead += range.bytes;
    } catch (error) {
      checkSignal(signal);
      const reason = error instanceof IndexedRefusal ? error.reason : undefined;
      return {
        status: 'omitted',
        omitted: {
          id: range.id,
          reason: reason === 'stale' || reason === 'too-large' || reason === 'unavailable' ? reason : 'invalid-data',
        },
      };
    }
  }
  return { status: 'loaded', rows, bytesRead };
}
