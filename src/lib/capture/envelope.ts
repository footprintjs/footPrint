/**
 * capture/envelope.ts — RFC-001 Block 1: capture envelopes + payload summarizer.
 *
 * Pattern:  Point-in-time capture. An observer event is snapshotted into a
 *           self-contained, immutable envelope at the moment it happens, so
 *           DELIVERY can be deferred (RFC-001 "one beat behind") without the
 *           payload drifting under later engine mutations.
 * Role:     The capture tier of the deferred-observer pipeline
 *           (`src/lib/observer-queue/`). Pure module — ZERO engine imports
 *           (only `capture/` internals); the engine wiring is RFC-001
 *           Blocks 6–10.
 *
 * Capture policies (RFC-001 §5):
 *   - `'summary'` — bounded, reference-free summarization via
 *     {@link summarizePayload}. Built on the SAME classification path as the
 *     retention markers in `summarize.ts` (#14 / #13c-A), extended with
 *     bounded structural descent. Structured-clone-safe by construction.
 *   - `'clone'`   — `structuredClone` at capture time (the capture-tier
 *     spelling of retention `'full'` — see the mapping notes in
 *     `policies.ts`). If the payload is not clonable (functions, symbols,
 *     live handles), capture DEGRADES to `'summary'` and reports through the
 *     `warn` hook — a capture must never throw into the producer.
 *   - `'ref'`     — pass-through of the live reference. The CALLER asserts
 *     immutability for the delivery window (safe e.g. for committed-state
 *     reads, proven immutable-after-swap in #13/#13b). Exempt from the
 *     clone-safety guarantee — see the dev-warn seam below.
 *
 * Dev-warn seam (resolves the isDevMode-would-be-an-engine-import problem):
 *   This module must not import `scope/detectCircular` (engine territory).
 *   Instead, `capture()` accepts {@link CaptureHooks} with an optional
 *   `warn` callback and invokes it on every `'ref'` capture and every
 *   `'clone'` degradation. The WIRING layer (Block 6) binds `warn` to an
 *   `isDevMode()`-gated, deduplicated console warner; the pure module stays
 *   engine-free and silent by default (no hooks ⇒ no warning, zero cost).
 *
 * Summarizer bounds (documented contract, exported as constants):
 *   - depth   ≤ {@link PAYLOAD_SUMMARY_MAX_DEPTH}   (3) — deeper structure
 *     collapses to a classified leaf with `depthClipped: true`.
 *   - breadth ≤ {@link PAYLOAD_SUMMARY_MAX_ENTRIES} (16) per object/array —
 *     the remainder is dropped and flagged `truncated: true` (the honest
 *     `size` still reports the real count).
 *   - total   ≤ {@link PAYLOAD_SUMMARY_MAX_NODES}   (128) summary nodes per
 *     payload — a global budget so wide×deep payloads stay O(1)-bounded.
 *   - string previews ≤ `SUMMARY_PREVIEW_LENGTH` (80) chars.
 *   Cycles are detected (ancestor set) and flagged `circular: true`;
 *   throwing getters yield a `'unreadable'` leaf; symbol-keyed properties
 *   are ignored (same as JSON / `Object.keys`); `Map`/`Set` are leaves with
 *   their REAL entry count (no descent — matches `summarize.ts`).
 */

import { type SummaryValueType, summarizeWriteValue } from './summarize.js';

/** Which observer channel produced a captured event (RFC-001 §5). */
export type CaptureChannel = 'scope' | 'flow' | 'emit';

/**
 * How an event payload is materialized into the envelope (RFC-001 §5).
 * See the module header for the full per-policy contract.
 */
export type CapturePolicy = 'summary' | 'clone' | 'ref';

/**
 * A captured observer event — self-contained and immutable (shallow-frozen
 * at creation). `seq` is the arrival stamp assigned at capture under the
 * single JS thread: it totally orders events ACROSS all three channels, is
 * monotonic, and is gap-detectable (a dropped event leaves a visible hole
 * in the delivered `seq` sequence — honest loss accounting).
 */
export interface CaptureEnvelope {
  /** Arrival stamp — total order across channels; gaps reveal drops. */
  readonly seq: number;
  /** Producing observer channel. */
  readonly channel: CaptureChannel;
  /** Producing hook name — `'onWrite'`, `'onStageExecuted'`, `'onEmit'`, ... */
  readonly method: string;
  /** The execution step that produced the event (`stageId#executionIndex`). */
  readonly runtimeStageId: string;
  /** The run that produced the event (Convention 4 per-run scoping). */
  readonly runId: string;
  /**
   * Per {@link CapturePolicy} — NEVER a live engine reference under
   * `'summary'` / `'clone'`; under `'ref'` the caller asserted immutability.
   */
  readonly payload: unknown;
  /** Capture wall-clock (ms epoch by default; injectable via hooks.now). */
  readonly capturedAt: number;
}

/** The raw event description handed to {@link capture}. */
export interface CaptureRequest {
  /** Arrival stamp — assigned by the merged queue's counter (Block 3). */
  readonly seq: number;
  readonly channel: CaptureChannel;
  readonly method: string;
  readonly runtimeStageId: string;
  readonly runId: string;
  /** The LIVE payload — `capture()` materializes it per policy. */
  readonly payload: unknown;
}

/**
 * Engine-free seams injected by the wiring layer (Block 6). The pure module
 * never imports dev-mode or clock infrastructure.
 */
export interface CaptureHooks {
  /**
   * Diagnostic sink — invoked on every `'ref'` capture (caller-asserted
   * immutability) and every `'clone'` → `'summary'` degradation. Block 6
   * binds this to an `isDevMode()`-gated, deduplicated warner.
   */
  readonly warn?: (message: string) => void;
  /** Clock for `capturedAt` — defaults to `Date.now`. Injectable for tests. */
  readonly now?: () => number;
}

/** Max nesting depth a payload summary descends before clipping. */
export const PAYLOAD_SUMMARY_MAX_DEPTH = 3;

/** Max entries summarized per object/array level before truncating. */
export const PAYLOAD_SUMMARY_MAX_ENTRIES = 16;

/** Global per-payload budget of summary nodes (wide×deep hard bound). */
export const PAYLOAD_SUMMARY_MAX_NODES = 128;

/**
 * Leaf classification for a summary node — the `summarize.ts` family plus
 * `'unreadable'` for properties whose getter threw during capture.
 */
export type PayloadSummaryType = SummaryValueType | 'unreadable';

/**
 * One node of a payload summary tree. Every field is a primitive, a plain
 * object, or a plain array — structured-clone-safe by construction.
 */
export interface PayloadSummaryNode {
  /** Classification — same rules as the retention markers (one code path). */
  readonly type: PayloadSummaryType;
  /** Honest size proxy: string length, array length, or key/entry count. */
  readonly size?: number;
  /** First `SUMMARY_PREVIEW_LENGTH` chars — primitives/strings only. */
  readonly preview?: string;
  /** Summarized own enumerable string-keyed properties (objects). */
  readonly fields?: Readonly<Record<string, PayloadSummaryNode>>;
  /** Summarized leading items (arrays). */
  readonly items?: readonly PayloadSummaryNode[];
  /** Entries were omitted here (breadth cap or node budget). */
  readonly truncated?: boolean;
  /** This value is an ancestor of itself — descent stopped. */
  readonly circular?: true;
  /** {@link PAYLOAD_SUMMARY_MAX_DEPTH} reached — children not descended. */
  readonly depthClipped?: true;
}

/**
 * Root of a payload summary — branded so consumers (and tests) can detect
 * that a payload was summarized rather than cloned. Sibling of the
 * `__readSummary` / `__writeSummary` retention markers.
 */
export interface PayloadSummary extends PayloadSummaryNode {
  /** Discriminant — `'summary'`-policy envelope payloads carry this. */
  readonly __payloadSummary: true;
}

/** Mutable construction shape for {@link PayloadSummaryNode}. */
interface SummaryNodeDraft {
  type: PayloadSummaryType;
  size?: number;
  preview?: string;
  fields?: Record<string, PayloadSummaryNode>;
  items?: PayloadSummaryNode[];
  truncated?: boolean;
  circular?: true;
  depthClipped?: true;
}

/** Shared mutable node budget for one {@link summarizePayload} call. */
interface SummarizeBudget {
  nodesLeft: number;
}

/**
 * Classify one value through the ONE classification path shared with the
 * retention markers. GATE NOTE: Block 1 may not modify `summarize.ts`, so
 * the module-private `classifyValue` is reached through its exported facade
 * and the brand field is dropped by explicit copy — Block 6 may export
 * `classifyValue` directly and inline this hop.
 */
function classifyLeaf(value: unknown): SummaryNodeDraft {
  const marker = summarizeWriteValue(value);
  const leaf: SummaryNodeDraft = { type: marker.type };
  if (marker.size !== undefined) leaf.size = marker.size;
  if (marker.preview !== undefined) leaf.preview = marker.preview;
  return leaf;
}

/** Read one child property, converting throwing getters into a leaf. */
function summarizeChild(
  parent: object,
  key: string | number,
  depth: number,
  budget: SummarizeBudget,
  ancestors: Set<object>,
): PayloadSummaryNode {
  let child: unknown;
  try {
    child = (parent as Record<string | number, unknown>)[key];
  } catch {
    return { type: 'unreadable', preview: '[getter threw during capture]' };
  }
  return summarizeNode(child, depth, budget, ancestors);
}

function summarizeNode(
  value: unknown,
  depth: number,
  budget: SummarizeBudget,
  ancestors: Set<object>,
): PayloadSummaryNode {
  budget.nodesLeft -= 1;
  const leaf = classifyLeaf(value);

  // Only plain containers descend. Map/Set stay leaves (real entry count
  // already on `size` — matches summarize.ts); everything else is a leaf.
  const container = (leaf.type === 'object' || leaf.type === 'array') && typeof value === 'object' && value !== null;
  if (!container || value instanceof Map || value instanceof Set) return leaf;

  const obj = value as object;
  if (ancestors.has(obj)) return { ...leaf, circular: true };
  if (depth >= PAYLOAD_SUMMARY_MAX_DEPTH) return { ...leaf, depthClipped: true };
  if (budget.nodesLeft <= 0) return { ...leaf, truncated: true };

  ancestors.add(obj);
  try {
    if (Array.isArray(value)) {
      const limit = Math.min(value.length, PAYLOAD_SUMMARY_MAX_ENTRIES);
      const items: PayloadSummaryNode[] = [];
      let clipped = value.length > limit;
      for (let i = 0; i < limit; i++) {
        if (budget.nodesLeft <= 0) {
          clipped = true;
          break;
        }
        items.push(summarizeChild(value, i, depth + 1, budget, ancestors));
      }
      return clipped ? { ...leaf, items, truncated: true } : { ...leaf, items };
    }

    const keys = Object.keys(obj);
    const limit = Math.min(keys.length, PAYLOAD_SUMMARY_MAX_ENTRIES);
    // Built via entries + fromEntries so hostile keys ('__proto__', ...)
    // become own data properties — never prototype writes.
    const entries: Array<[string, PayloadSummaryNode]> = [];
    let clipped = keys.length > limit;
    for (let i = 0; i < limit; i++) {
      if (budget.nodesLeft <= 0) {
        clipped = true;
        break;
      }
      entries.push([keys[i], summarizeChild(obj, keys[i], depth + 1, budget, ancestors)]);
    }
    const fields = Object.fromEntries(entries);
    return clipped ? { ...leaf, fields, truncated: true } : { ...leaf, fields };
  } finally {
    ancestors.delete(obj);
  }
}

/**
 * Produce a bounded, reference-free, structured-clone-safe summary of an
 * arbitrary payload. Never throws; never holds a reference into the source
 * value (every node is a fresh object whose fields are primitives). Bounds
 * are documented in the module header.
 */
export function summarizePayload(payload: unknown): PayloadSummary {
  const budget: SummarizeBudget = { nodesLeft: PAYLOAD_SUMMARY_MAX_NODES };
  const root = summarizeNode(payload, 0, budget, new Set<object>());
  return { __payloadSummary: true, ...root };
}

/** Materialize the payload per policy — see the module header contract. */
function capturePayload(request: CaptureRequest, policy: CapturePolicy, hooks?: CaptureHooks): unknown {
  if (policy === 'ref') {
    hooks?.warn?.(
      `[footprintjs capture] 'ref' capture for ${request.channel}.${request.method} passes a LIVE reference ` +
        'through deferred delivery — the caller asserts the payload is immutable until delivered.',
    );
    return request.payload;
  }
  if (policy === 'clone') {
    try {
      return structuredClone(request.payload);
    } catch {
      hooks?.warn?.(
        `[footprintjs capture] 'clone' capture for ${request.channel}.${request.method} failed ` +
          "(structuredClone threw — unclonable payload); degraded to 'summary'.",
      );
      return summarizePayload(request.payload);
    }
  }
  return summarizePayload(request.payload);
}

/**
 * Capture one observer event into an immutable {@link CaptureEnvelope}.
 *
 * Guarantees:
 *   - Never throws into the producer (`'clone'` degradation, summarizer
 *     never-throws contract).
 *   - The returned envelope is shallow-frozen — `seq`/`channel`/... cannot
 *     be reassigned. Under `'summary'`/`'clone'` the payload holds no live
 *     reference into the source; under `'ref'` it intentionally does.
 *   - Default policy is `'summary'` (cheapest safe tier).
 */
export function capture(
  request: CaptureRequest,
  policy: CapturePolicy = 'summary',
  hooks?: CaptureHooks,
): CaptureEnvelope {
  const capturedAt = hooks?.now !== undefined ? hooks.now() : Date.now();
  return Object.freeze({
    seq: request.seq,
    channel: request.channel,
    method: request.method,
    runtimeStageId: request.runtimeStageId,
    runId: request.runId,
    payload: capturePayload(request, policy, hooks),
    capturedAt,
  });
}
