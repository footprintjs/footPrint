import type { RecordEntry } from 'foottrace/write';

import { ownData } from '../capture/noteShape.js';
import {
  checkSignal,
  indexedAddress,
  IndexedRefusal,
  indexedText,
  invalidIndexedData,
  MAX_PUBLISHED_VIEW_BYTES,
} from './indexedAdmission.js';
import { digest, readBytes } from './indexedIO.js';
import type { IndexedLimits } from './indexedTypes.js';
import type { PublishedRecordRange } from './publishedRecordWriter.js';

type WrittenRange = Extract<PublishedRecordRange, { status: 'written' }>;
export type PublishedOmissionReason = 'too-large' | 'unavailable' | 'invalid-data' | 'stale';

const MAX_NODES = 200000;
const MAX_DEPTH = 100;

interface ReadBudget {
  bytes: number;
  rows: number;
  nodes: number;
}

type RowLimits = Pick<IndexedLimits, 'maxScopeBytes' | 'maxEntries' | 'maxEntryBytes'>;

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
    invalidIndexedData();
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
  invalidIndexedData();
}

function spendNode(budget: ReadBudget, depth: number): void {
  if (--budget.nodes < 0 || depth > MAX_DEPTH) throw new IndexedRefusal('too-large');
}

function endOfString(text: string, start: number): number {
  for (let offset = start + 1; offset < text.length; offset++) {
    if (text[offset] === '\\') offset++;
    else if (text[offset] === '"') return offset;
  }
  invalidIndexedData();
}

/**
 * Charge the root, each object value and each array element before allocating decoded rows.
 * Strings are opaque here. JSON.parse still owns JSON syntax and decoding.
 */
function checkJsonWork(text: string, budget: ReadBudget): void {
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

function planOmissions(
  ranges: readonly PublishedRecordRange[],
  limits: RowLimits,
  stopAt?: number,
): readonly PublishedOmissionReason[] {
  // Physical ranges can split around another scope. Report distinct reasons for the admitted selection.
  const reasons = new Set<PublishedOmissionReason>();
  let bytes = 0;
  let rows = 0;
  let physicalBytes = 0;
  const tail = ranges.at(-1);
  for (const range of ranges) {
    if (range.status === 'omitted') {
      reasons.add(range.reason);
      continue;
    }
    physicalBytes += range.bytes;
    // A final range can pack later rows. Its digest covers every byte, while the
    // caller's limits count only the native rows selected for the query.
    if (stopAt !== undefined && range === tail && range.rowCount > 1) continue;
    bytes += range.bytes;
    rows += range.rowCount;
    if (range.maxLineBytes > limits.maxEntryBytes) reasons.add('too-large');
  }
  if (physicalBytes > MAX_PUBLISHED_VIEW_BYTES || bytes > limits.maxScopeBytes || rows > limits.maxEntries)
    reasons.add('too-large');
  return [...reasons].sort();
}

async function readRange(
  fd: number,
  scope: string,
  range: WrittenRange,
  maxEntryBytes: number,
  signal: AbortSignal,
  count: (bytes: number) => void,
  submitted: () => void,
  budget: ReadBudget,
  stopAt?: number,
): Promise<readonly RecordEntry[]> {
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
    if (end < 0 || end === start || rows.length >= range.rowCount || closedThrough !== undefined) invalidIndexedData();
    const lineBytes = end + 1 - start;
    budget.bytes -= lineBytes;
    if (lineBytes > maxEntryBytes || --budget.rows < 0 || budget.bytes < 0) throw new IndexedRefusal('too-large');
    if (lineBytes > range.maxLineBytes) invalidIndexedData();
    maxLineBytes = Math.max(maxLineBytes, lineBytes);
    const text = indexedText(bytes.subarray(start, end));
    checkJsonWork(text, budget);
    const row = admitRow(JSON.parse(text), scope);
    if (row.kind === 'commit') {
      const position = row.bundle.idx;
      if (
        position === undefined ||
        range.firstCommit === undefined ||
        range.lastCommit === undefined ||
        position < range.firstCommit ||
        position > range.lastCommit
      )
        invalidIndexedData();
      firstCommit = Math.min(firstCommit ?? position, position);
      lastCommit = Math.max(lastCommit ?? position, position);
    } else if (row.kind === 'closed') {
      closedThrough = row.commits - 1;
    }
    rows.push(row);
    start = end + 1;
    if (
      stopAt !== undefined &&
      start < bytes.length &&
      (stopAt === -1 ? row.kind === 'opened' : row.kind === 'commit' && row.bundle.idx === stopAt)
    ) {
      if (rows.length >= range.rowCount) invalidIndexedData();
      return rows;
    }
  }
  if (
    rows.length !== range.rowCount ||
    maxLineBytes !== range.maxLineBytes ||
    firstCommit !== range.firstCommit ||
    lastCommit !== range.lastCommit ||
    closedThrough !== range.closedThrough
  )
    invalidIndexedData();
  return rows;
}

export async function readPublishedRows(
  fd: number,
  scope: string,
  ranges: readonly PublishedRecordRange[],
  limits: RowLimits,
  signal: AbortSignal,
  count: (bytes: number) => void,
  submitted: () => void,
  stopAt?: number,
): Promise<
  | { readonly status: 'loaded'; readonly rows: readonly RecordEntry[] }
  | { readonly status: 'omitted'; readonly reasons: readonly PublishedOmissionReason[] }
> {
  const rows: RecordEntry[] = [];
  const budget = { bytes: limits.maxScopeBytes, rows: limits.maxEntries, nodes: MAX_NODES };
  const tail = ranges.at(-1);
  const omissions = planOmissions(ranges, limits, stopAt);
  if (omissions.length) return { status: 'omitted', reasons: omissions };
  for (const range of ranges) {
    if (range.status !== 'written') invalidIndexedData();
    try {
      const part = await readRange(
        fd,
        scope,
        range,
        limits.maxEntryBytes,
        signal,
        count,
        submitted,
        budget,
        range === tail ? stopAt : undefined,
      );
      for (const row of part) rows.push(row);
    } catch (error) {
      checkSignal(signal);
      const reason = error instanceof IndexedRefusal ? error.reason : undefined;
      return {
        status: 'omitted',
        reasons: [reason === 'stale' || reason === 'too-large' || reason === 'unavailable' ? reason : 'invalid-data'],
      };
    }
  }
  return { status: 'loaded', rows };
}
