/**
 * sinks/fileSink.ts — the record, one JSON line per entry, in a file (design §3.5, §4, packet P6). NODE ONLY: the
 * one file in `src/` that imports a Node built-in, reachable only through the `footprintjs/sinks` door.
 *
 * WHY A FILE, WHY THIS SHAPE. A run's record must outlive the process that made it — a killed process, a crashed
 * host, a serverless freeze. Each entry the log hands over is queued and appended at once, asynchronously, in
 * order: it reaches the operating system within the I/O pool's turnaround (the next append starts the moment the
 * previous one ends), so a process killed after that keeps it; `flush()` waits for the queue and `fsync`s — the step
 * that also survives the machine losing power, and the one the executor awaits after each run's closing entry.
 *
 * THE THREAT MODEL, as code — every resource bounded, nothing that can stall the run:
 *   - ONLY THE PATH THE APP GIVES. Resolved once and opened once, at `fileSink(path)`; every entry goes to that open
 *     file. A symbolic link at the path is refused (`O_NOFOLLOW`, where the platform has it), and so is anything
 *     that is not a regular file, a file with another hard link, another owner, or group/world write. A file the
 *     sink creates is `0o600`.
 *   - ATOMIC PER ENTRY. A line is encoded in full first — an entry JSON cannot write (a `BigInt`, a cycle) is
 *     refused whole — then appended (`O_APPEND`). A write that fails part-way leaves a torn line; the NEXT entry
 *     starts on a new line, so a torn line never swallows the one after it (an existing file with a torn tail too).
 *   - BOUNDED: `maxEntryBytes` (one line, 8 MiB — refused by name, before it is encoded when its length already
 *     says so), `maxQueuedBytes` (accepted, not yet written, 16 MiB — past it an entry is DROPPED and counted, never
 *     buffered without limit), `maxBytes` (the file, 64 MiB — once full, every further entry is refused and counted;
 *     a closing entry may use a 64 KiB reserve so a full file can still say how the run ended), `flushTimeoutMs`
 *     (10 s — then `flush()` rejects). Every refusal throws from the sink method, which the log counts
 *     (`getSnapshot().sink`); a write that fails later rejects that entry's promise, counted the same way.
 *   - ASYNCHRONOUS WRITES ONLY. No method blocks on the disk; one append is in flight at a time.
 *   - NO SECRET ON DISK is the EXECUTOR's law, applied before any entry reaches an adapter (`runner/recordSink.ts`):
 *     this file writes what it is handed and reads nothing else.
 *   - ONE WRITER PER FILE. The size bound counts what this sink accepted on top of the file's size when it opened.
 *
 * WHAT JSON KEEPS. A line holds what `JSON.stringify` keeps: a `Date` becomes its ISO string, a `Map` / `Set` an
 * empty object, `undefined` disappears. A record of plain JSON values reads back exactly (`readRecordFile` →
 * `readStoredRecord`); for richer values, bring an adapter with a richer encoding.
 */

import { closeSync, constants, fstatSync, fsync, openSync, readSync, write } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { getuid } from 'node:process';

import type { RecordEntry, RecordSink } from 'foottrace/write';

/** The default cap on a record file: 64 MiB. */
export const DEFAULT_FILE_SINK_MAX_BYTES = 64 * 1024 * 1024;
/** The default cap on ONE entry's line: 8 MiB. */
export const DEFAULT_FILE_SINK_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
/** The default cap on bytes accepted but not yet written: 16 MiB. */
export const DEFAULT_FILE_SINK_MAX_QUEUED_BYTES = 16 * 1024 * 1024;
/** The default bound on `flush()`: 10 s. */
export const DEFAULT_FILE_SINK_FLUSH_TIMEOUT_MS = 10_000;
/** How far past `maxBytes` a CLOSING entry may still go, so a full file can say how the run ended: 64 KiB. */
const CLOSE_RESERVE_BYTES = 64 * 1024;
/** The default cap `readRecordFile` reads: 256 MiB. */
const DEFAULT_READ_MAX_BYTES = 256 * 1024 * 1024;

/** `fileSink`'s options — every resource the sink can spend, bounded. */
export interface FileSinkOptions {
  /**
   * The most bytes the file may hold (the bytes already in it count). Once an entry would pass it, the file is FULL:
   * that entry and every later one is refused and counted by the run, never written — except a closing entry, which
   * may use 64 KiB more so a full file can still say how the run ended. Default 64 MiB.
   */
  readonly maxBytes?: number;
  /** The largest ONE entry's line may be; a larger entry is refused whole (`maxEntryBytes` named). Default 8 MiB. */
  readonly maxEntryBytes?: number;
  /**
   * The most bytes accepted and not yet on disk. Writes are asynchronous, so a sink slower than the run queues; past
   * this bound an entry is DROPPED and counted (never buffered without limit, never a stall). Default 16 MiB.
   */
  readonly maxQueuedBytes?: number;
  /** How long `flush()` (drain the queue, then `fsync`) may take before it rejects. Default 10 s. */
  readonly flushTimeoutMs?: number;
}

/** A record sink that appends to one file — `RecordSink` plus what the app needs to manage the file. */
export interface FileSink extends RecordSink {
  /** The absolute path the sink writes to — resolved once, when it was made. */
  readonly path: string;
  /** How many bytes the file holds, as this sink knows it (what was there, plus what it wrote). */
  readonly bytes: number;
  /** Bytes accepted and not yet written. */
  readonly queuedBytes: number;
  /** `true` once an entry was refused for `maxBytes`: the file is full, and only a closing entry may still go. */
  readonly full: boolean;
  /**
   * Release the file. Idempotent. Every entry after it is refused (the run counts it), and `flush()` rejects;
   * entries already accepted are still written, then the file is closed.
   */
  close(): void;
}

/** One accepted line, waiting for its turn; its promise is what the log watches. */
interface Queued {
  readonly line: Uint8Array;
  readonly done: () => void;
  readonly fail: (error: unknown) => void;
}

/**
 * A record sink that appends each entry to `path` as one JSON line — the crash-safe record on a Node host.
 *
 * Every method returns at once: the line is encoded, checked against every bound and QUEUED, and the queue is
 * written in order with asynchronous appends (one in flight at a time), each started as soon as the one before it
 * ends — so an entry reaches the operating system within the I/O pool's turnaround, not at the next flush. The
 * method's promise settles when that line is written; a write that fails rejects it, and the run counts the loss.
 *
 * @throws TypeError when `path` is not a non-empty string or does not name a regular file the writer owns alone;
 *   RangeError for a bound that is not a whole number ≥ 1 (`flushTimeoutMs` ≥ 0); the operating system's error when
 *   the file cannot be opened (a symbolic link at `path` included). Made once, at setup — never during a run.
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
  const maxBytes = bound('maxBytes', options?.maxBytes, DEFAULT_FILE_SINK_MAX_BYTES, 1);
  const maxEntryBytes = bound('maxEntryBytes', options?.maxEntryBytes, DEFAULT_FILE_SINK_MAX_ENTRY_BYTES, 1);
  const maxQueuedBytes = bound('maxQueuedBytes', options?.maxQueuedBytes, DEFAULT_FILE_SINK_MAX_QUEUED_BYTES, 1);
  const flushTimeoutMs = bound('flushTimeoutMs', options?.flushTimeoutMs, DEFAULT_FILE_SINK_FLUSH_TIMEOUT_MS, 0);
  const absolute = resolvePath(path);
  const fd = openSync(
    absolute,
    constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let written: number; // bytes in the file, as this sink knows it
  let needsNewline: boolean; // the last line in the file is torn: the next write starts a new one
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new TypeError(`fileSink: ${absolute} is not a regular file`);
    refuseForeign(absolute, stat);
    written = stat.size;
    needsNewline = written > 0 && !endsWithNewline(fd, written);
  } catch (error) {
    closeSync(fd);
    throw error;
  }

  const encoder = new TextEncoder();
  const queue: Queued[] = [];
  let queuedBytes = 0;
  let accepted = written; // the file's size once everything queued is written — what `maxBytes` bounds
  let writing = false;
  let full = false;
  let closing = false;
  let released = false;
  let drained: (() => void)[] = [];

  const release = (): void => {
    if (released) return;
    released = true;
    closeSync(fd);
  };

  /** Write the queue's head, then the next — one append in flight, in order. */
  const pump = (): void => {
    if (writing) return;
    const head = queue[0];
    if (head === undefined) {
      const waiting = drained;
      drained = [];
      for (const resolve of waiting) resolve();
      if (closing) release();
      return;
    }
    writing = true;
    const torn = needsNewline;
    const buffer = torn ? prefixed(head.line) : head.line;
    if (torn) accepted += 1;
    appendAll(fd, buffer, (error, wrote) => {
      writing = false;
      queue.shift();
      queuedBytes -= head.line.length;
      written += wrote;
      if (error) {
        accepted -= buffer.length - wrote;
        // A line cut part-way must not swallow the next entry.
        if (wrote > 0) needsNewline = true;
        head.fail(error);
      } else {
        needsNewline = false;
        head.done();
      }
      pump();
    });
  };

  /** One entry: refused whole with a named bound (the log counts it), or queued — never written in part, never blocking. */
  const enqueue = (entry: RecordEntry): Promise<void> => {
    if (closing) throw new Error(`fileSink: ${absolute} is closed`);
    const json = JSON.stringify(entry); // an entry JSON cannot write (a BigInt, a cycle) throws here, whole
    // A string's length never exceeds its UTF-8 size: an entry already too long is refused before it is encoded.
    if (json.length + 1 > maxEntryBytes) throw tooLarge(absolute, entry.kind, maxEntryBytes);
    const line = encoder.encode(`${json}\n`);
    if (line.length > maxEntryBytes) throw tooLarge(absolute, entry.kind, maxEntryBytes);
    const limit = entry.kind === 'closed' ? maxBytes + CLOSE_RESERVE_BYTES : maxBytes;
    if ((full && entry.kind !== 'closed') || accepted + line.length + 1 > limit) {
      if (entry.kind !== 'closed') full = true;
      throw new RangeError(
        `fileSink: ${absolute} is full (maxBytes ${maxBytes}); this ${entry.kind} entry was not written`,
      );
    }
    if (queuedBytes + line.length > maxQueuedBytes) {
      throw new RangeError(
        `fileSink: ${absolute} has ${queuedBytes} bytes waiting (maxQueuedBytes ${maxQueuedBytes}); this ${entry.kind} entry was dropped`,
      );
    }
    return new Promise<void>((resolve, reject) => {
      queue.push({ line, done: resolve, fail: reject });
      queuedBytes += line.length;
      accepted += line.length;
      pump();
    });
  };

  return {
    path: absolute,
    get bytes() {
      return written;
    },
    get queuedBytes() {
      return queuedBytes;
    },
    get full() {
      return full;
    },
    opened: ({ address, at, initialState, meta }) =>
      enqueue({ kind: 'opened', address, at, initialState, ...(meta === undefined ? {} : { meta }) }),
    commit: ({ address, at, bundle }) => enqueue({ kind: 'commit', address, at, bundle }),
    note: ({ address, at, kind, data }) => enqueue({ kind: 'note', address, at, note: kind, data }),
    closed: ({ address, at, outcome, commits, meta }) =>
      enqueue({ kind: 'closed', address, at, outcome, commits, ...(meta === undefined ? {} : { meta }) }),
    flush: () => {
      if (closing) return Promise.reject(new Error(`fileSink: ${absolute} is closed`));
      const work = new Promise<void>((resolve, reject) => {
        drained.push(() => fsync(fd, (error) => (error ? reject(error) : resolve())));
        pump();
      });
      return withTimeout(
        work,
        flushTimeoutMs,
        `fileSink: flush() of ${absolute} did not finish in ${flushTimeoutMs}ms`,
      );
    },
    close: () => {
      if (closing) return;
      closing = true;
      if (!writing && queue.length === 0) release();
    },
  };
}

/** A bound read off the options: absent → the default; else a whole number ≥ `min`, or a RangeError naming it. */
function bound(name: string, value: number | undefined, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`fileSink: ${name} must be a whole number${min > 0 ? `, at least ${min}` : ' ≥ 0'}`);
  }
  return value;
}

function tooLarge(path: string, kind: string, maxEntryBytes: number): RangeError {
  return new RangeError(
    `fileSink: a ${kind} entry larger than maxEntryBytes (${maxEntryBytes}) was not written to ${path}`,
  );
}

/** `line` after a newline — closing a torn line the file ends with. */
function prefixed(line: Uint8Array): Uint8Array {
  const out = new Uint8Array(line.length + 1);
  out[0] = 0x0a;
  out.set(line, 1);
  return out;
}

/** Append all of `buffer` (asynchronously, as many writes as it takes); `wrote` is how much went out. */
function appendAll(fd: number, buffer: Uint8Array, done: (error: Error | null, wrote: number) => void): void {
  const step = (offset: number): void => {
    write(fd, buffer, offset, buffer.length - offset, null, (error, n) => {
      if (error) done(error, offset);
      else if (offset + n < buffer.length) step(offset + n);
      else done(null, buffer.length);
    });
  };
  step(0);
}

/** `work`, or a rejection naming the bound once `ms` passed — the work goes on, nobody waits for it. */
function withTimeout(work: Promise<void>, ms: number, message: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    Promise.prototype.then.call(
      work,
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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
