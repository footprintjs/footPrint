/**
 * sinks/fileSink.ts — the record, one JSON line per entry, in a file (design §3.5, §4, packet P6). NODE ONLY: the
 * one file in `src/` that imports a Node built-in, reachable only through the `footprintjs/sinks` door.
 *
 * WHY A FILE, WHY THIS SHAPE. A run's record must outlive the process that made it — a killed process, a crashed
 * host, a serverless freeze. Each entry the log hands over is encoded, checked and given its own offset in the file,
 * and its write is handed to the I/O pool AT ONCE (a positional write — no entry waits for the event loop to turn);
 * the pool's threads perform them while the main thread runs on. A process killed after a pool thread wrote an entry
 * keeps it. Until then it is not on disk: microseconds on a free pool, but the pool (4 threads by default) is shared
 * with DNS lookups, zlib, crypto and other fs work, so while it is busy the window is as long as that work — and since
 * writes complete out of order, a kill can lose an entry in the middle (the reader reports the hole). `flush()` waits for every write and
 * `fsync`s — the step that also survives the machine losing power, and the one the executor awaits after each run's
 * closing entry.
 *
 * THE THREAT MODEL, as code — every resource bounded, nothing that can stall the run:
 *   - ONLY THE PATH THE APP GIVES. Resolved once and opened once, at `fileSink(path)`; every entry goes to that open
 *     file. A symbolic link at the path is refused (`O_NOFOLLOW`, where the platform has it), and so is anything
 *     that is not a regular file, a file with another hard link, another owner, or group/world write. A file the
 *     sink creates is `0o600`.
 *   - ATOMIC PER ENTRY. A line is encoded in full first — an entry JSON cannot write (a `BigInt`, a cycle) is
 *     refused whole — then written at its own offset. A write that fails part-way leaves a hole up to the next
 *     entry's offset; the reader splits at it (NUL), so a torn line never swallows the one after it (an existing
 *     file with a torn tail gets a newline first).
 *   - BOUNDED: `maxEntryBytes` (one line, 8 MiB — refused by name, before it is encoded when its length already
 *     says so), `maxQueuedBytes` (accepted, not yet written, 16 MiB — past it an entry is DROPPED and counted, never
 *     buffered without limit), `maxBytes` (the file, 64 MiB — once full, every further entry is refused and counted;
 *     a closing entry may use a 64 KiB reserve so a full file can still say how the run ended), `flushTimeoutMs`
 *     (10 s — then `flush()` rejects). Every refusal throws from the sink method, which the log counts
 *     (`getSnapshot().sink`); a write that fails later rejects that entry's promise, counted the same way.
 *   - ASYNCHRONOUS WRITES ONLY. No method blocks on the disk; the file is released asynchronously, after every
 *     write and every started fsync.
 *   - NO SECRET ON DISK is the EXECUTOR's law, applied before any entry reaches an adapter (`runner/recordSink.ts`):
 *     this file writes what it is handed and reads nothing else.
 *   - ONE WRITER PER FILE. A second sink on a file this process has open is refused (by device and inode, across the
 *     CommonJS and ESM builds). ANOTHER PROCESS writing the same path is not seen at open: each writes at its own
 *     offsets and would overwrite the other. `flush()` checks the file's size against what this sink placed and rejects
 *     (a loss the run counts) when another writer's bytes reach past it — best effort: an overwrite this sink's own
 *     later writes cover is not seen. Give each process its own file.
 *
 * WHAT JSON KEEPS. A line holds what `JSON.stringify` keeps: a `Date` becomes its ISO string, a `Map` / `Set` an
 * empty object, `undefined` disappears. A record of plain JSON values reads back exactly (`readRecordFile` →
 * `readStoredRecord`); for richer values, bring an adapter with a richer encoding.
 */

import { close, closeSync, constants, fstat, fstatSync, fsync, openSync, readSync, write } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { getuid } from 'node:process';

import type { RecordEntry, RecordSink } from 'foottrace/write';

import { setLongTimeout } from '../attempt/longTimeout.js';
import type { CaptureHistoryOptions } from '../capture/historyTypes.js';

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
export interface FileSink extends RecordSink, Pick<CaptureHistoryOptions, 'acknowledge'> {
  /** The absolute path the sink writes to — resolved once, when it was made. */
  readonly path: string;
  /**
   * Bytes this sink knows are on disk: the file's size when it opened plus every byte its writes completed — a
   * running sum, not the file's end (writes complete out of order; a failed one leaves a hole).
   */
  readonly bytes: number;
  /** Bytes accepted and not yet written. */
  readonly queuedBytes: number;
  /** `true` once an entry was refused for `maxBytes`: the file is full, and only a closing entry may still go. */
  readonly full: boolean;
  /**
   * Release the file. Idempotent. Every entry after it is refused (the run counts it), and `flush()` rejects;
   * entries already accepted are still written (and a flush already started finishes), then the file is closed —
   * the promise settles then.
   */
  close(): Promise<void>;
}

/**
 * A record sink that appends each entry to `path` as one JSON line — the crash-safe record on a Node host.
 *
 * Every method returns at once: the line is encoded, checked against every bound, given its offset and handed to
 * the I/O pool. The method's promise settles when that line is written; a write that fails rejects it, and the run
 * counts the loss.
 *
 * @throws TypeError when `path` is not a non-empty string or does not name a regular file the writer owns alone;
 *   RangeError for a bound that is not a whole number ≥ 1; the operating system's error when
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
  const flushTimeoutMs = bound('flushTimeoutMs', options?.flushTimeoutMs, DEFAULT_FILE_SINK_FLUSH_TIMEOUT_MS, 1);
  const absolute = resolvePath(path);
  // NOT `O_APPEND`: each entry is written at the offset it was given when it was queued (a positional write), so
  // every entry is handed to the I/O pool the moment it is accepted — none waits for the event loop to turn.
  const fd = openSync(absolute, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  let identity: string;
  let size: number;
  let needsNewline: boolean; // the file ends with a torn line: the first entry starts a new one
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new TypeError(`fileSink: ${absolute} is not a regular file`);
    refuseForeign(absolute, stat);
    identity = `${stat.dev}:${stat.ino}`;
    // One writer per file, in this process: a second sink would place its entries over the first's.
    if (OPEN_FILES.has(identity)) throw new TypeError(`fileSink: ${absolute} already has an open sink in this process`);
    size = stat.size;
    needsNewline = size > 0 && !endsWithNewline(fd, size);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  OPEN_FILES.add(identity);

  const encoder = new TextEncoder();
  let next = size; // the offset the next accepted entry is written at — what `maxBytes` bounds
  let written = size; // bytes known on disk
  let queuedBytes = 0; // accepted, not yet written (in the I/O pool's hands)
  let inFlight = 0;
  let syncing = 0;
  let full = false;
  let closing = false;
  let released = false;
  let drained: (() => void)[] = [];
  let closedSignal: (() => void) | undefined;
  const whenReleased = new Promise<void>((resolve) => (closedSignal = resolve));

  /** Release the file once nothing is in flight and no fsync is pending — asynchronously; an error is ignored. */
  const releaseIfIdle = (): void => {
    if (!closing || released || inFlight > 0 || syncing > 0) return;
    released = true;
    OPEN_FILES.delete(identity);
    close(fd, () => closedSignal?.());
  };

  /** Everything accepted is written: start each waiting flush's fsync, then release if closing. */
  const settleDrained = (): void => {
    if (inFlight > 0) return;
    const waiting = drained;
    drained = [];
    for (const start of waiting) start();
    releaseIfIdle();
  };

  /** One entry: refused whole with a named bound (the log counts it), or submitted — never in part, never blocking. */
  const enqueue = (entry: RecordEntry): Promise<void> => {
    if (closing) throw new Error(`fileSink: ${absolute} is closed`);
    // The cheap refusals first: a full file or a full queue costs no encoding.
    if (full && entry.kind !== 'closed') throw fileFull(absolute, maxBytes, entry.kind);
    // A closing entry is exempt from the queue bound (as from `maxBytes`, within its reserve): how a log ended is
    // the one entry a full queue must not drop.
    const isClosingEntry = entry.kind === 'closed';
    if (!isClosingEntry && queuedBytes >= maxQueuedBytes)
      throw queueFull(absolute, queuedBytes, maxQueuedBytes, entry.kind);
    const json = JSON.stringify(entry); // an entry JSON cannot write (a BigInt, a cycle) throws here, whole
    // A string's length never exceeds its UTF-8 size: an entry already too long is refused before it is encoded.
    if (json.length + 1 > maxEntryBytes) throw tooLarge(absolute, entry.kind, maxEntryBytes);
    const encoded = encoder.encode(`${needsNewline ? '\n' : ''}${json}\n`);
    if (encoded.length > maxEntryBytes + 1) throw tooLarge(absolute, entry.kind, maxEntryBytes);
    const limit = entry.kind === 'closed' ? maxBytes + CLOSE_RESERVE_BYTES : maxBytes;
    if (next + encoded.length > limit) {
      if (entry.kind !== 'closed') full = true;
      throw fileFull(absolute, maxBytes, entry.kind);
    }
    if (!isClosingEntry && queuedBytes + encoded.length > maxQueuedBytes) {
      throw queueFull(absolute, queuedBytes, maxQueuedBytes, entry.kind);
    }
    needsNewline = false;
    const at = next;
    next += encoded.length;
    queuedBytes += encoded.length;
    inFlight += 1;
    return new Promise<void>((resolve, reject) => {
      writeAt(fd, encoded, at, (error, wrote) => {
        inFlight -= 1;
        queuedBytes -= encoded.length;
        written += wrote;
        // A line cut short leaves a hole up to the next entry's offset: the reader splits at it (NUL), so a torn
        // line never swallows the entry after it.
        if (error) reject(error);
        else resolve();
        settleDrained();
      });
    });
  };

  const adapter: FileSink = {
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
    // Explicit file capability: fsync of all preceding entries. This is not assumed for other adapters.
    acknowledge: async (target) => {
      await adapter.flush!();
      return Object.freeze({ ...target, durability: 'durable' });
    },
    flush: () => {
      if (closing) return Promise.reject(new Error(`fileSink: ${absolute} is closed`));
      const work = new Promise<void>((resolve, reject) => {
        drained.push(() => {
          syncing += 1;
          fsync(fd, (error) => {
            if (error) {
              syncing -= 1;
              reject(error);
              releaseIfIdle();
              return;
            }
            // Another writer (another process on the same path) grew the file past what this sink placed: its
            // entries and ours overlap. Said, never silent.
            fstat(fd, (statError, stat) => {
              syncing -= 1;
              if (statError) reject(statError);
              else if (stat.size > next) {
                reject(new Error(`fileSink: ${absolute} was written by another writer (one sink per file)`));
              } else resolve();
              releaseIfIdle();
            });
          });
        });
        settleDrained();
      });
      return withTimeout(
        work,
        flushTimeoutMs,
        `fileSink: flush() of ${absolute} did not finish in ${flushTimeoutMs}ms`,
      );
    },
    close: () => {
      if (!closing) {
        closing = true;
        releaseIfIdle();
      }
      return whenReleased;
    },
  };
  return adapter;
}

/**
 * Files a sink of this process has open, by device and inode — one writer per file. Kept on the global object, so
 * the package's CommonJS and ESM builds (two module instances in one process) share it.
 */
const OPEN_FILES: Set<string> = ((globalThis as Record<symbol, unknown>)[Symbol.for('footprintjs.fileSink.open')] ??=
  new Set<string>()) as Set<string>;

function fileFull(path: string, maxBytes: number, kind: string): RangeError {
  return new RangeError(`fileSink: ${path} is full (maxBytes ${maxBytes}); this ${kind} entry was not written`);
}

function queueFull(path: string, queued: number, maxQueuedBytes: number, kind: string): RangeError {
  return new RangeError(
    `fileSink: ${path} has ${queued} bytes waiting (maxQueuedBytes ${maxQueuedBytes}); this ${kind} entry was dropped`,
  );
}

/** A bound read off the options: absent → the default; else a whole number ≥ `min`, or a RangeError naming it. */
function bound(name: string, value: number | undefined, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`fileSink: ${name} must be a whole number, at least ${min}`);
  }
  return value;
}

function tooLarge(path: string, kind: string, maxEntryBytes: number): RangeError {
  return new RangeError(
    `fileSink: a ${kind} entry larger than maxEntryBytes (${maxEntryBytes}) was not written to ${path}`,
  );
}

/** Write all of `buffer` at `position` (asynchronously, as many writes as it takes); `wrote` is how much went out. */
function writeAt(
  fd: number,
  buffer: Uint8Array,
  position: number,
  done: (error: Error | null, wrote: number) => void,
): void {
  const step = (offset: number): void => {
    write(fd, buffer, offset, buffer.length - offset, position + offset, (error, n) => {
      if (error) done(error, offset);
      else if (n === 0) done(new Error('fileSink: the disk took no bytes'), offset);
      else if (offset + n < buffer.length) step(offset + n);
      else done(null, buffer.length);
    });
  };
  step(0);
}

/** `work`, or a rejection naming the bound once `ms` passed — the work goes on, nobody waits for it. */
function withTimeout(work: Promise<void>, ms: number, message: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // The one long-timer law (`attempt/longTimeout.ts`): a bound past 2^31 − 1 ms is waited in full, never 1 ms.
    // A timer that only bounds a wait never keeps the process alive on its own (`unref`).
    const cancel = setLongTimeout(() => reject(new Error(message)), ms, { unref: true });
    Promise.prototype.then.call(
      work,
      () => {
        cancel();
        resolve();
      },
      (error: unknown) => {
        cancel();
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
  const maxBytes = bound('maxBytes', options?.maxBytes, DEFAULT_READ_MAX_BYTES, 1);
  // One descriptor for the check AND the read (a file that grows between them is still bounded); a regular file
  // only (a FIFO would block, a device never end); at most `maxBytes` read.
  // O_NONBLOCK: a FIFO at the path must not block the open before the regular-file check refuses it.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
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
    // A run of NUL bytes is a hole a cut-short write left before the next entry's offset: it ends the torn part,
    // so the entry after it reads on its own (the same line number names both pieces).
    const line = lines[i];
    // A hole is reported, never skipped: bytes that never reached the disk may be a whole entry lost mid-file.
    if (line.includes('\0')) unreadable.push({ line: i + 1, reason: 'a hole — bytes that never reached the disk' });
    for (const piece of line.split(/\0+/)) {
      if (piece.trim() === '') continue;
      try {
        entries.push(JSON.parse(piece));
      } catch {
        unreadable.push({ line: i + 1, reason: 'not JSON — a torn or corrupt line' });
      }
    }
  }
  return { entries, unreadable };
}
