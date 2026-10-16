/**
 * attempt/correlation.ts — the run's correlation: the W3C `traceparent` codec and the ONE resolution of the env
 * into a `RunCorrelation` (design docs/design/2026-10-time-and-failure-evidence.md §3.4, packet P4).
 *
 * THREAT MODEL. A `traceparent` comes from whoever sent the request. So:
 *   - it is read STRICTLY to the W3C Trace Context grammar (`version-traceid-parentid-flags`, lowercase hex) and
 *     anything else is refused by a NAMED reason (`TraceparentError.reason`) — the message never repeats the
 *     header, and the error holds no copy of it;
 *   - what the run keeps is the canonical form of what was parsed (`formatTraceparent`), never the received
 *     bytes — a future version's tail is dropped;
 *   - it is correlation only: a name the record carries so a run can be found from a trace. Nothing in the
 *     library treats it as identity or authorisation.
 *
 * W3C forward compatibility: a version other than `00` (and never `ff`) is read by its first four fields; a
 * longer header must continue with `-`. Version `00` is exactly 55 characters. A header longer than
 * {@link MAX_HEADER_LENGTH} is refused before it is scanned.
 */

import type { RunCorrelation } from './types.js';

/** Why a `traceparent` was refused — a NAME, so a caller can branch on it without reading a message. */
export type TraceparentRefusal =
  | 'not-a-string'
  | 'length'
  | 'version'
  | 'characters'
  | 'zero-trace-id'
  | 'zero-parent-id';

/** A parsed `traceparent`: the W3C trace-id, the parent-id (the caller's unit of work), and the sampled flag. */
export interface ParsedTraceparent {
  /** 32 lowercase hex, not all zeros. */
  readonly traceId: string;
  /** The W3C parent-id — 16 lowercase hex, not all zeros. The library's word for it is "operation". */
  readonly operationId: string;
  /** Bit 0 of trace-flags. Other flag bits are read but not carried. */
  readonly sampled: boolean;
}

/** What `formatTraceparent` writes from. `sampled` absent reads as `false`. */
export interface TraceparentFields {
  readonly traceId: string;
  readonly operationId: string;
  readonly sampled?: boolean;
}

/** The longest header read at all (a future version may append fields; nothing legitimate is near this). */
export const MAX_HEADER_LENGTH = 256;
/** A version-00 header, exactly. */
const V00_LENGTH = 55;

const WHY: Readonly<Record<TraceparentRefusal, string>> = {
  'not-a-string': 'it is not a string',
  length: 'its length is not a W3C traceparent length (55 characters for version 00)',
  version: 'its version is not two lowercase hex digits other than ff',
  characters: 'it is not lowercase hex fields in the W3C layout version-traceid-parentid-flags',
  'zero-trace-id': 'its trace-id is all zeros',
  'zero-parent-id': 'its parent-id is all zeros',
};

/** A `traceparent` the library will not read. The header itself is never in the message or on the error. */
export class TraceparentError extends Error {
  readonly reason: TraceparentRefusal;

  constructor(reason: TraceparentRefusal) {
    super(`traceparent refused (${reason}): ${WHY[reason]}`);
    this.name = 'TraceparentError';
    this.reason = reason;
  }
}

const HEX2 = /^[0-9a-f]{2}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const ZEROS = /^0+$/;

/**
 * Parse a W3C `traceparent` header strictly. Returns a frozen {@link ParsedTraceparent}; throws a
 * {@link TraceparentError} naming the first rule the header breaks.
 *
 * @example
 * parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
 * // { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', operationId: '00f067aa0ba902b7', sampled: true }
 */
export function parseTraceparent(header: unknown): ParsedTraceparent {
  if (typeof header !== 'string') throw new TraceparentError('not-a-string');
  if (header.length < V00_LENGTH || header.length > MAX_HEADER_LENGTH) throw new TraceparentError('length');
  const version = header.slice(0, 2);
  if (!HEX2.test(version) || version === 'ff') throw new TraceparentError('version');
  if (version === '00' && header.length !== V00_LENGTH) throw new TraceparentError('length');

  const traceId = header.slice(3, 35);
  const operationId = header.slice(36, 52);
  const flags = header.slice(53, 55);
  const laidOut = header[2] === '-' && header[35] === '-' && header[52] === '-';
  const tailOk = header.length === V00_LENGTH || header[V00_LENGTH] === '-';
  if (!laidOut || !tailOk || !HEX32.test(traceId) || !HEX16.test(operationId) || !HEX2.test(flags)) {
    throw new TraceparentError('characters');
  }
  if (ZEROS.test(traceId)) throw new TraceparentError('zero-trace-id');
  if (ZEROS.test(operationId)) throw new TraceparentError('zero-parent-id');

  return Object.freeze({ traceId, operationId, sampled: (parseInt(flags, 16) & 1) === 1 });
}

/**
 * Write a version-00 `traceparent` — for an outbound call that continues this run's trace. Both ids must be W3C
 * ids (refused by name otherwise, like a parse); `sampled` sets bit 0 of trace-flags, every other bit is zero.
 *
 * @example
 * formatTraceparent({ traceId, operationId: mySpanId, sampled: true }); // '00-<traceId>-<mySpanId>-01'
 */
export function formatTraceparent(fields: TraceparentFields): string {
  const { traceId, operationId } = fields;
  if (typeof traceId !== 'string' || typeof operationId !== 'string') throw new TraceparentError('not-a-string');
  if (!HEX32.test(traceId) || !HEX16.test(operationId)) throw new TraceparentError('characters');
  if (ZEROS.test(traceId)) throw new TraceparentError('zero-trace-id');
  if (ZEROS.test(operationId)) throw new TraceparentError('zero-parent-id');
  return `00-${traceId}-${operationId}-${fields.sampled === true ? '01' : '00'}`;
}

/** The env fields correlation reads — structural, so this L5 file names nothing of the engine's `ExecutionEnv`. */
export interface CorrelationEnv {
  readonly traceparent?: unknown;
  readonly traceId?: unknown;
  readonly operationId?: unknown;
}

/** An explicit id: 1–256 printable ASCII characters, no space — a name a log line or an exporter can carry. */
const EXPLICIT_ID = /^[\x21-\x7e]{1,256}$/;

/**
 * Admit a leg's env ONCE (called by `FlowChartExecutor · run` / `resume` before anything moves): a single
 * own-property snapshot of it — every getter runs once, nothing is read off the prototype — and the correlation
 * resolved from that snapshot. In the snapshot the stages see (`$getEnv()`), `traceparent` is the canonical
 * header of what was parsed, never the received bytes. `env` is `undefined` exactly when none was given.
 */
export function admitRunEnv<E extends object>(
  env: E | undefined,
): { readonly env: E | undefined; readonly correlation: RunCorrelation | undefined } {
  if (env === undefined || env === null) return { env: undefined, correlation: undefined };
  const snapshot = { ...env } as E & { traceparent?: unknown };
  const parsed = resolveParsed(snapshot);
  if (parsed.header) snapshot.traceparent = formatTraceparent(parsed.header);
  return { env: snapshot, correlation: parsed.correlation };
}

/**
 * The ONE resolution of a leg's correlation from its env. Only OWN fields count. `traceparent` is parsed once (a
 * bad header refuses the leg — explicit ids do not rescue it); explicit `traceId` / `operationId` win over the
 * header's and must be 1–256 printable ASCII characters (refused by field name, never echoed); an empty one is
 * no id. The header's `sampled` and `traceparent` ride only while the trace IS the header's, and `traceparent`
 * is rebuilt from the EFFECTIVE ids (omitted when the operation is not a W3C parent-id), so the record never
 * names one trace and propagates another. Returns `undefined` when there is no trace id at all — and refuses
 * an `operationId` with no trace to belong to.
 */
export function resolveCorrelation(env: CorrelationEnv | undefined): RunCorrelation | undefined {
  if (env === undefined || env === null) return undefined;
  return resolveParsed({ ...env }).correlation;
}

function resolveParsed(env: CorrelationEnv): {
  header?: ParsedTraceparent;
  correlation?: RunCorrelation;
} {
  const header = own(env, 'traceparent') === undefined ? undefined : parseTraceparent(env.traceparent);
  const traceId = explicitId(own(env, 'traceId'), 'traceId') ?? header?.traceId;
  const operationId = explicitId(own(env, 'operationId'), 'operationId') ?? header?.operationId;
  if (traceId === undefined) {
    if (operationId !== undefined) {
      throw new TypeError('env.operationId needs a trace to belong to: give env.traceId or env.traceparent');
    }
    return { header };
  }
  const sameTrace = header !== undefined && traceId === header.traceId;
  const propagable = sameTrace && operationId !== undefined && HEX16.test(operationId) && !ZEROS.test(operationId);
  const correlation: RunCorrelation = Object.freeze({
    traceId,
    ...(operationId !== undefined && { operationId }),
    ...(sameTrace && { sampled: header.sampled }),
    ...(propagable && { traceparent: formatTraceparent({ traceId, operationId, sampled: header.sampled }) }),
  });
  return { header, correlation };
}

/** An own field's value — a value inherited through the prototype is not the caller's. */
function own(env: CorrelationEnv, field: keyof CorrelationEnv): unknown {
  return Object.prototype.hasOwnProperty.call(env, field) ? env[field] : undefined;
}

function explicitId(value: unknown, field: 'traceId' | 'operationId'): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw new TypeError(`env.${field} must be a string`);
  if (!EXPLICIT_ID.test(value)) {
    throw new TypeError(`env.${field} refused: an id is 1–256 printable ASCII characters with no space`);
  }
  return value;
}
