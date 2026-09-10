/**
 * redaction.ts — The ONE owner of what a redaction policy says about a value.
 *
 * THE LAW (9.19.0). A redaction policy covers EVERYTHING RETAINED OR SERVED —
 * the commit log (both encodings), the redacted mirror, stage reads/writes
 * retention, the narrative, a subflow's seed and merge-back — and NEVER the
 * live heap the run computes on nor the resume checkpoint (resumption must
 * replay real values; the checkpoint is handed to the runner, never served).
 *
 * HOW ONE OWNER KEEPS IT. Every staged write and every tracked read passes
 * through `StageContext`, so `StageContext` asks THIS rule — not the caller —
 * what the policy says about the path it is about to retain. A `ScopeFacade`
 * write, a subflow `inputMapper` seed, an `outputMapper` merge-back and a
 * resume re-seed are then all the same case: the funnel decides, the caller
 * cannot forget to. The facade uses the same rule for the values it hands to
 * recorders; `SubflowExecutor` uses it for the narrated seed. Before 9.19.0
 * the facade held the verdict alone, and every path that wrote or read past
 * the facade — five of them — retained plaintext under a policy.
 *
 * TWO PLACEHOLDERS, BOTH HISTORICAL: the commit log and the mirror carry
 * `'REDACTED'` (`redactPatch`, unchanged since 4.x); every scope-tier view —
 * recorder events, `stageReads`/`stageWrites`, narrative — carries
 * `'[REDACTED]'` ({@link REDACTED}). Neither string changed in 9.19.0.
 */

import { isDevMode } from '../scope/detectCircular.js';
import { nativeHas, nativeSet } from './pathOps.js';

/**
 * Declarative redaction configuration — define once, applied everywhere.
 *
 * Configure at the scope class level (static property) or pass to
 * FlowChartExecutor to apply across all stages.
 */
export interface RedactionPolicy {
  /** Exact key names to always redact (e.g. ['ssn', 'creditCard']). */
  keys?: string[];
  /**
   * Regex patterns — any key matching a pattern is auto-redacted.
   *
   * Pattern matching is skipped for keys that exceed an internal length cap
   * (designed to prevent ReDoS on pathological patterns). For very long key
   * names, use `keys` (exact match) instead of patterns.
   */
  patterns?: RegExp[];
  /** Field-level redaction within objects — key → array of fields to scrub.
   *  Supports dot-notation for nested paths (e.g. 'address.zip'). */
  fields?: Record<string, string[]>;
  /**
   * Regex patterns matched against `EmitEvent.name` for `scope.$emit(...)`
   * calls. Any emit event whose name matches has its payload replaced with
   * the string `'[REDACTED]'` before dispatch to recorders.
   *
   * Example:
   * ```ts
   * { emitPatterns: [/\.auth\./, /\.billing\./] }
   * // Hides payloads of events like 'myapp.auth.check' and 'myapp.billing.spend'
   * ```
   */
  emitPatterns?: RegExp[];
}

/**
 * Compliance-friendly report of what was redacted. Never includes values.
 */
export interface RedactionReport {
  /** Keys fully redacted (exact match or pattern match). */
  redactedKeys: string[];
  /** Keys with field-level redaction → which fields were scrubbed. */
  fieldRedactions: Record<string, string[]>;
  /** Pattern sources that were active (e.g. ['password|secret']). */
  patterns: string[];
}

/** The scope-tier placeholder — recorder events, retention, narrative. */
export const REDACTED = '[REDACTED]';

/**
 * What the policy says about the value at one user-level path.
 *
 * - `'clear'`  — nothing to scrub; retain and serve the value as it is.
 * - `'whole'`  — the entire value is secret. `key` is the policy or marked
 *   key that decided it (the path itself or one of its ancestors).
 * - `'fields'` — the value is an object whose `paths` (dot-paths INSIDE the
 *   value, relative to it) are secret; everything else in it is not.
 */
export type RedactionVerdict =
  | { readonly kind: 'clear' }
  | { readonly kind: 'whole'; readonly key: string }
  | { readonly kind: 'fields'; readonly key: string; readonly paths: readonly string[] };

export const CLEAR: RedactionVerdict = Object.freeze({ kind: 'clear' } as const);

/**
 * Maximum key length (characters) that will be tested against regex redaction
 * patterns. Keys longer than this are skipped for pattern matching to prevent
 * ReDoS: a pathological regex tested against an unboundedly long key string
 * can cause catastrophic backtracking. 256 characters comfortably exceeds any
 * realistic scope-state key name.
 */
const MAX_PATTERN_KEY_LEN = 256;

export class RedactionRule {
  private policy: RedactionPolicy | undefined;
  /** Whether `policy` names anything a state verdict can act on — computed
   *  once per `setPolicy` so {@link isInert} is a two-field check. */
  private policyActive = false;
  /**
   * Keys marked secret for the rest of the run — by a per-call
   * `setValue(key, value, true)`, or by any write the policy redacted whole.
   * ONE set per run, shared by every scope and context (the executor builds
   * the rule once per run and installs it on the runtime root).
   */
  private marked: Set<string>;

  constructor(policy?: RedactionPolicy, marked?: Set<string>) {
    this.marked = marked ?? new Set<string>();
    this.setPolicy(policy);
  }

  getPolicy(): RedactionPolicy | undefined {
    return this.policy;
  }

  setPolicy(policy: RedactionPolicy | undefined): void {
    this.policy = policy;
    this.policyActive =
      policy !== undefined &&
      ((policy.keys?.length ?? 0) > 0 ||
        (policy.patterns?.length ?? 0) > 0 ||
        Object.keys(policy.fields ?? {}).length > 0);
  }

  /**
   * True when this rule has nothing to say about ANY path — no key, pattern
   * or field in the policy and no key marked so far. The no-policy fast
   * path: `StageContext` skips the verdict (and its path allocation) on
   * every tracked read and staged write while this holds. A per-call
   * `setValue(key, value, true)` marks a key and ends it.
   */
  isInert(): boolean {
    return this.marked.size === 0 && !this.policyActive;
  }

  /** The shared marked-keys set — for the `@internal` sharing protocol and `decide()`. */
  markedKeys(): Set<string> {
    return this.marked;
  }

  useMarkedKeys(shared: Set<string>): void {
    this.marked = shared;
  }

  mark(key: string): void {
    this.marked.add(key);
  }

  /** Deleting a key clears its per-call mark; a policy verdict survives it. */
  unmark(key: string): void {
    this.marked.delete(key);
  }

  /** Key-level verdict: marked, listed in `policy.keys`, or matching a pattern. */
  isKeyRedacted(key: string): boolean {
    if (this.marked.has(key)) return true;
    if (!this.policy) return false;
    if (this.policy.keys?.includes(key)) return true;
    const patterns = this.policy.patterns;
    if (!patterns || patterns.length === 0) return false;
    if (key.length > MAX_PATTERN_KEY_LEN) {
      if (isDevMode()) {
        // eslint-disable-next-line no-console
        console.warn(
          `[footprint] RedactionPolicy: key '${key.slice(0, 40)}...' (${key.length} chars) exceeds ` +
            'the pattern-matching length cap and was skipped. ' +
            'Use policy.keys for exact matching of long key names.',
        );
      }
      return false;
    }
    for (const p of patterns) {
      p.lastIndex = 0; // Reset stateful global/sticky regexes
      if (p.test(key)) return true;
    }
    return false;
  }

  /**
   * The verdict for a user-level path — `['profile']` for a scope key,
   * `['profile', 'auth']` for a nested write such as a subflow seed.
   *
   * Every dotted prefix is tested at key level (`profile`, then
   * `profile.auth`), so a policy that names a key covers everything written
   * beneath it. `fields` are declared relative to the TOP key; for a nested
   * path they are re-based onto the value being written, and a field that
   * names the written path exactly makes the whole value secret.
   */
  verdict(path: readonly string[]): RedactionVerdict {
    if (path.length === 0) return CLEAR;
    if (path.length === 1) return this.verdictOfKey(path[0]);
    let dotted = '';
    for (let i = 0; i < path.length; i++) {
      dotted = i === 0 ? path[0] : `${dotted}.${path[i]}`;
      if (this.isKeyRedacted(dotted)) return { kind: 'whole', key: dotted };
    }
    const fields = this.policy?.fields?.[path[0]];
    if (!fields || fields.length === 0) return CLEAR;
    if (path.length === 1) return { kind: 'fields', key: path[0], paths: fields };
    const rel = path.slice(1).join('.');
    const inside: string[] = [];
    for (const field of fields) {
      // The written path IS a secret field: the whole value is secret, and
      // the key that decided it is that dotted path — never the top key,
      // whose siblings stay clear.
      if (field === rel) return { kind: 'whole', key: dotted };
      if (field.startsWith(`${rel}.`)) inside.push(field.slice(rel.length + 1));
    }
    return inside.length > 0 ? { kind: 'fields', key: path[0], paths: inside } : CLEAR;
  }

  /**
   * The verdict for `key` written or read under `path` — the common
   * single-segment case (`path` empty: every facade write and read) decides
   * on the key string alone, no array allocated.
   */
  verdictAt(path: readonly string[], key: string): RedactionVerdict {
    return path.length === 0 ? this.verdictOfKey(key) : this.verdict([...path, key]);
  }

  /** The single-segment verdict: key-level hit → whole; declared fields → fields. */
  private verdictOfKey(key: string): RedactionVerdict {
    if (this.isKeyRedacted(key)) return { kind: 'whole', key };
    const fields = this.policy?.fields?.[key];
    return fields !== undefined && fields.length > 0 ? { kind: 'fields', key, paths: fields } : CLEAR;
  }

  /**
   * The retained / served form of a value at a path: the placeholder, a
   * scrubbed CLONE, or the value itself (same reference — recorders receive
   * borrowed live references for clear values, as they always have).
   * `placeholder` defaults to the scope-tier `'[REDACTED]'`; the mirror seed
   * passes the log's `'REDACTED'`.
   */
  retain(path: readonly string[], value: unknown, placeholder: string = REDACTED): unknown {
    return RedactionRule.apply(this.verdict(path), value, placeholder);
  }

  /**
   * The retained form of a whole record (a subflow seed, a whole-state read):
   * each top-level key through {@link retain}. Returns the SAME object when
   * nothing in it is redacted, so the no-policy path allocates nothing.
   */
  retainRecord<T>(record: T, placeholder: string = REDACTED): T {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return record;
    let out: Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
      const kept = this.retain([key], value, placeholder);
      if (kept === value) continue;
      out ??= { ...(record as Record<string, unknown>) };
      out[key] = kept;
    }
    return (out ?? record) as T;
  }

  /**
   * The retained form of a whole STATE — {@link retainRecord} over the root
   * keys AND over every run namespace under `runs` (fork children write
   * there; a checkpoint's `sharedState` carries it back as a seed). This is
   * what seeds the redacted mirror: the store's starting state, scrubbed
   * with the log's placeholder, so a policy key that arrives by seed and is
   * never re-written is still served as the placeholder.
   */
  retainState<T>(state: T, placeholder: string = REDACTED): T {
    const kept = this.retainRecord(state, placeholder);
    if (kept === null || typeof kept !== 'object') return kept;
    const runs = (kept as { runs?: unknown }).runs;
    if (runs === null || typeof runs !== 'object' || Array.isArray(runs)) return kept;
    let scrubbedRuns: Record<string, unknown> | undefined;
    for (const [runId, record] of Object.entries(runs as Record<string, unknown>)) {
      const keptRun = this.retainRecord(record, placeholder);
      if (keptRun === record) continue;
      scrubbedRuns ??= { ...(runs as Record<string, unknown>) };
      scrubbedRuns[runId] = keptRun;
    }
    return scrubbedRuns === undefined ? kept : ({ ...(kept as object), runs: scrubbedRuns } as T);
  }

  /** Apply a verdict to a value — see {@link retain}. */
  static apply(verdict: RedactionVerdict, value: unknown, placeholder: string = REDACTED): unknown {
    if (verdict.kind === 'whole') return placeholder;
    if (verdict.kind === 'fields') return RedactionRule.scrubFields(value, verdict.paths, placeholder) ?? value;
    return value;
  }

  /**
   * A deep clone of `value` with the given dot-paths replaced by the
   * placeholder — `undefined` when `value` is not an object (there is nothing
   * to scrub in a scalar; the caller keeps the value). A path that exists as
   * a literal key (`'a.b'` as one property) is scrubbed as that key;
   * otherwise it is walked as a nested path. Paths that do not exist are
   * ignored — scrubbing never invents a field.
   */
  static scrubFields(
    value: unknown,
    paths: readonly string[],
    placeholder: string = REDACTED,
  ): Record<string, unknown> | undefined {
    if (value === null || typeof value !== 'object') return undefined;
    const copy = structuredClone(value) as Record<string, unknown>;
    for (const path of paths) {
      if (Object.prototype.hasOwnProperty.call(copy, path)) {
        copy[path] = placeholder;
      } else if (path.includes('.') && nativeHas(copy, path)) {
        nativeSet(copy, path, placeholder);
      }
    }
    return copy;
  }

  report(): RedactionReport {
    const fieldRedactions: Record<string, string[]> = {};
    for (const [key, fields] of Object.entries(this.policy?.fields ?? {})) {
      fieldRedactions[key] = [...fields];
    }
    return {
      redactedKeys: [...this.marked],
      fieldRedactions,
      patterns: (this.policy?.patterns ?? []).map((p) => p.source),
    };
  }
}
