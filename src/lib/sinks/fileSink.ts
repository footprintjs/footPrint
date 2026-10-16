/**
 * sinks/fileSink.ts — the record, one JSON line per entry, in a file (design §3.5, §4, packet P6). NODE ONLY: the
 * one file in `src/` that imports a Node built-in, reachable only through the `footprintjs/sinks` door.
 *
 * WHY A FILE, WHY THIS SHAPE. A run's record must outlive the process that made it — a killed process, a crashed
 * host, a serverless freeze. Each entry the log hands over is written WHOLE, with one append, before the call
 * returns: once `commit` / `note` / `closed` returns, the line is in the operating system's hands, so a process
 * killed at any later instant cannot take it back. `flush()` (`fsync`) is the step that also survives the machine
 * losing power; the executor awaits it after each run's closing entry unless told `flush: 'manual'`.
 *
 * THE THREAT MODEL, as code:
 *   - ONLY THE PATH THE APP GIVES. The path is resolved once and opened once, at `fileSink(path)`; every entry goes
 *     to that open file, never to a path built later. A symbolic link at the path is refused (`O_NOFOLLOW`, where
 *     the platform has it), and so is anything that is not a regular file. A file the sink creates is readable and
 *     writable by its owner only (`0o600`); an existing file keeps its mode.
 *   - ATOMIC PER ENTRY. A line is encoded in full first — an entry JSON cannot write (a `BigInt`, a cycle) is
 *     refused whole, nothing written — then appended (`O_APPEND`). A write that fails part-way leaves a torn line;
 *     the NEXT entry starts on a new line, so a torn line never swallows the one after it. An existing file whose
 *     last line was torn (a previous process died mid-write) is treated the same way.
 *   - BOUNDED. `maxBytes` (default 64 MiB) caps the file: an entry that would pass it is refused, never written,
 *     and the run counts the loss (`getSnapshot().sink`); a closing entry may use a small reserve past it, so a
 *     full file can still say how the run ended. A refused commit reads back as a gap at its own index.
 *   - NO SECRET ON DISK is the EXECUTOR's law, applied before any entry reaches an adapter (`runner/recordSink.ts`):
 *     this file writes what it is handed and reads nothing else.
 *
 * WHAT JSON KEEPS. A line holds what `JSON.stringify` keeps: a `Date` becomes its ISO string, a `Map` / `Set` an
 * empty object, `undefined` disappears. A record of plain JSON values reads back exactly (`readRecordFile` →
 * `readStoredRecord`); for richer values, bring an adapter with a richer encoding.
 */

import { closeSync, constants, fstatSync, fsync, openSync, readSync, writeSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { getuid } from 'node:process';

import type { RecordEntry, RecordSink } from 'foottrace/write';

/** The default cap on a record file: 64 MiB. */
export const DEFAULT_FILE_SINK_MAX_BYTES = 64 * 1024 * 1024;
/** How far past `maxBytes` a CLOSING entry may still go, so a full file can say how the run ended: 64 KiB. */
const CLOSE_RESERVE_BYTES = 64 * 1024;
/** The default cap `readRecordFile` reads: 256 MiB. */
const DEFAULT_READ_MAX_BYTES = 256 * 1024 * 1024;

/** `fileSink`'s options. */
export interface FileSinkOptions {
  /**
   * The most bytes the file may hold (the bytes already in it count). An entry that would pass it is refused and
   * counted by the run, never written; a closing entry may use 64 KiB more. A whole number ≥ 1. Default 64 MiB.
   */
  readonly maxBytes?: number;
}

/** A record sink that appends to one file — `RecordSink` plus what the app needs to manage the file. */
export interface FileSink extends RecordSink {
  /** The absolute path the sink writes to — resolved once, when it was made. */
  readonly path: string;
  /** How many bytes the file holds, as this sink knows it (what was there, plus what it wrote). */
  readonly bytes: number;
  /** Release the file. Idempotent. Every entry after it is refused (the run counts it), and `flush()` rejects. */
  close(): void;
}

/**
 * A record sink that appends each entry to `path` as one JSON line — the crash-safe record on a Node host.
 *
 * @throws TypeError when `path` is not a non-empty string or does not name a regular file; RangeError for a
 *   `maxBytes` that is not a whole number ≥ 1; the operating system's error when the file cannot be opened (a
 *   symbolic link at `path` included). Made once, at setup — never during a run.
 *
 * @example
 * ```typescript
 * import { fileSink, readRecordFile } from 'footprintjs/sinks';
 * import { readStoredRecord } from 'foottrace';
 *
 * const sink = fileSink('/var/footprint/orders.jsonl');
 * const executor = new FlowChartExecutor(chart, { sink });
 * await executor.run({ input });
 * // …later, or after a crash:
 * const record = readStoredRecord(readRecordFile('/var/footprint/orders.jsonl').entries);
 * record.root(runId)?.complete; // false for a run that never ended
 * ```
 */
export function fileSink(path: string, options?: FileSinkOptions): FileSink {
  if (typeof path !== 'string' || path === '') throw new TypeError('fileSink: path must be a non-empty string');
  const maxBytes = options?.maxBytes ?? DEFAULT_FILE_SINK_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('fileSink: maxBytes must be a whole number of bytes, at least 1');
  }
  const absolute = resolvePath(path);
  const fd = openSync(
    absolute,
    constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let bytes: number;
  let needsNewline: boolean;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new TypeError(`fileSink: ${absolute} is not a regular file`);
    refuseForeign(absolute, stat);
    bytes = stat.size;
    needsNewline = bytes > 0 && !endsWithNewline(fd, bytes);
  } catch (error) {
    closeSync(fd);
    throw error;
  }

  const encoder = new TextEncoder();
  let closed = false;

  /** One entry, one line, one append — or a throw and nothing written (the log counts it). */
  const write = (entry: RecordEntry): void => {
    if (closed) throw new Error(`fileSink: ${absolute} is closed`);
    // The file's size as it is NOW — another writer, or a truncation, is counted, not guessed.
    bytes = fstatSync(fd).size;
    const limit = entry.kind === 'closed' ? maxBytes + CLOSE_RESERVE_BYTES : maxBytes;
    const refused = () =>
      new RangeError(
        `fileSink: ${absolute} would pass its maxBytes (${maxBytes}); this ${entry.kind} entry was not written`,
      );
    const json = JSON.stringify(entry);
    // A string's length never exceeds its UTF-8 size: an entry already too long is refused before it is encoded.
    if (bytes + json.length > limit) throw refused();
    const line = encoder.encode(`${needsNewline ? '\n' : ''}${json}\n`);
    if (bytes + line.length > limit) throw refused();
    let written = 0;
    try {
      while (written < line.length) written += writeSync(fd, line, written, line.length - written);
    } finally {
      bytes += written;
      // A line that went out whole ends with its newline; one cut part-way must not swallow the next entry.
      if (written === line.length) needsNewline = false;
      else if (written > 0) needsNewline = true;
    }
  };

  return {
    path: absolute,
    get bytes() {
      return bytes;
    },
    opened: ({ address, at, initialState, meta }) =>
      write({ kind: 'opened', address, at, initialState, ...(meta === undefined ? {} : { meta }) }),
    commit: ({ address, at, bundle }) => write({ kind: 'commit', address, at, bundle }),
    note: ({ address, at, kind, data }) => write({ kind: 'note', address, at, note: kind, data }),
    closed: ({ address, at, outcome, commits, meta }) =>
      write({ kind: 'closed', address, at, outcome, commits, ...(meta === undefined ? {} : { meta }) }),
    flush: () =>
      new Promise<void>((resolve, reject) => {
        if (closed) {
          reject(new Error(`fileSink: ${absolute} is closed`));
          return;
        }
        fsync(fd, (error) => (error ? reject(error) : resolve()));
      }),
    close: () => {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  };
}

/**
 * Refuse a file someone else could read or rewrite behind the sink: a hard link (another name for the same bytes —
 * the sink would append into it), a file owned by another user, or one others may write. A file the sink creates is
 * `0o600` and passes; a pre-existing one must already be private to the writer. (Not on Windows, whose modes and
 * owners do not map: there `O_NOFOLLOW` is absent too — the guide names both.)
 */
function refuseForeign(path: string, stat: { readonly nlink: number; readonly uid: number; readonly mode: number }) {
  if (stat.nlink > 1) throw new TypeError(`fileSink: ${path} has other hard links — refusing to write through one`);
  const uid = typeof getuid === 'function' ? getuid() : undefined;
  if (uid !== undefined && stat.uid !== uid) throw new TypeError(`fileSink: ${path} belongs to another user`);
  if (uid !== undefined && (stat.mode & 0o022) !== 0) {
    throw new TypeError(`fileSink: ${path} is writable by others — make it 0o600 (or remove it) first`);
  }
}

/** Whether the file's last byte is a newline — read once, when the sink opens an existing file. */
function endsWithNewline(fd: number, size: number): boolean {
  const last = new Uint8Array(1);
  return readSync(fd, last, 0, 1, size - 1) === 1 && last[0] === 0x0a;
}

/** A record file read back: every parsed line, and every line that could not be. */
export interface RecordFile {
  /** The parsed entries, in file order — untrusted input for `readStoredRecord` (`foottrace`). */
  readonly entries: readonly unknown[];
  /** Each line that is not JSON (a torn last line, a corrupt one), by its 1-based number. Blank lines are skipped. */
  readonly unreadable: readonly { readonly line: number; readonly reason: string }[];
}

/**
 * Read a record file back, line by line — the entries for `readStoredRecord`, and every line that could not be
 * read, by number, never a failed read. A stored key named `__proto__` stays data (`JSON.parse` makes it an own
 * property). The file is untrusted: a file larger than `maxBytes` (default 256 MiB) is refused before it is read.
 *
 * @throws RangeError when the file is larger than `maxBytes`; the operating system's error when it cannot be read.
 */
export function readRecordFile(path: string, options?: { readonly maxBytes?: number }): RecordFile {
  if (typeof path !== 'string' || path === '') throw new TypeError('readRecordFile: path must be a non-empty string');
  const maxBytes = options?.maxBytes ?? DEFAULT_READ_MAX_BYTES;
  // One descriptor for the check AND the read (a file that grows between them is still bounded); a regular file
  // only (a FIFO would block, a device never end); at most `maxBytes` read.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let raw: Uint8Array;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new TypeError(`readRecordFile: ${path} is not a regular file`);
    if (stat.size > maxBytes) {
      throw new RangeError(`readRecordFile: ${path} holds ${stat.size} bytes, past the limit of ${maxBytes}`);
    }
    const buffer = new Uint8Array(Math.min(stat.size, maxBytes) + 1);
    let read = 0;
    for (;;) {
      const n = readSync(fd, buffer, read, buffer.length - read, read);
      if (n === 0) break;
      read += n;
      if (read === buffer.length) {
        throw new RangeError(`readRecordFile: ${path} grew past the limit of ${maxBytes} bytes while being read`);
      }
    }
    raw = buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
  const text = new TextDecoder('utf-8').decode(raw);
  const entries: unknown[] = [];
  const unreadable: { line: number; reason: string }[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      unreadable.push({ line: i + 1, reason: 'not JSON — a torn or corrupt line' });
    }
  }
  return { entries, unreadable };
}
