/**
 * redaction.ts — The ONE owner of what a redaction policy says about a value.
 *
 * THE LAW (owner ruling (a)). A redaction policy covers EVERYTHING the library
 * retains or serves — the commit log (both encodings), the redacted mirror,
 * tracked reads/writes, every recorder event (inline and deferred) and the
 * recorder rows built from them, the narrative, snapshots, diagnostics, pause
 * payloads, boundary records and log lines — and NEVER the live heap or the
 * resume checkpoint. Two values are the caller's own and stay real: the
 * `run()` rejection (the thrown value itself) and the live fork result.
 *
 * A policy selects by NAME — a key, a dotted path, a field — never by
 * scanning content. What carries a name:
 *   - state — its user-level path ({@link RedactionRule.verdict});
 *   - a record handed out whole — root input/output, a subflow's mapped seed
 *     and exit state, a pause payload, a thrown value — its keys at every
 *     depth ({@link RedactionRule.retainBoundary});
 *   - a diagnostic entry — `$debug`/`$error`/`$metric`/`$eval`/`$log` and the
 *     engine's own — the record `{ [name]: value }`: its name IS a state key
 *     ({@link RedactionRule.retainDiagnostic}). `policy.diagnostics` adds
 *     diagnostic-only selectors on top; flow-message text has no name of its
 *     own, so only they select it;
 *   - a subflow mapper's copy — a key an `inputMapper`/`outputMapper` (or a
 *     `parallelForEach` items selector) wrote inherits the redaction of the
 *     selected value it copied ({@link MapperTaint}).
 * A mark is a NAME, run-wide, until the key is deleted; a pause carries the
 * marks — names only — to the resumed run ({@link RedactionRule.marksForCheckpoint}).
 * A value with no name — a scalar root input/output or pause payload, free
 * error text — is selected by nothing. `emitPatterns` is the one separate
 * scrub: a `$emit` payload is selected by its event name.
 *
 * HOW ONE OWNER KEEPS IT. Every staged write and every tracked read passes
 * through `StageContext`, so `StageContext` asks THIS rule — not the caller —
 * what the policy says about the path it is about to retain. A `ScopeFacade`
 * write, a subflow `inputMapper` seed, an `outputMapper` merge-back and a
 * resume re-seed are then all the same case: the funnel decides, the caller
 * cannot forget to. The facade uses the same rule for the values it hands to
 * recorders; `SubflowExecutor` uses it for the narrated seed and
 * `FlowchartTraverser.execute` for root input/output before dispatch. Before 9.19.0
 * the facade held the verdict alone, and every path that wrote or read past
 * the facade — five of them — retained plaintext under a policy.
 *
 * ONE VERDICT OWNER, ONE ENCODING OWNER (C4). This file DECIDES — the rule,
 * and for a staged write {@link decideWrite} (the verdict),
 * {@link inheritByIdentity} and {@link markStagedWrite} (the marks) — and is
 * the engine's (L4, beside the run policy that carries the rule). The BYTES of a
 * verdict are the record's: the frame hands its scrub (`whole`, or the
 * `fields` inside the value — {@link scrubOf}) to `RecordFrame · write`, and
 * the record's own scrub (`memory/scrub.ts`, L2) writes the log's placeholder
 * at commit. Before C4 the scrub lived here too, so the record imported the
 * engine's policy module to write a string.
 *
 * TWO PLACEHOLDERS, BOTH HISTORICAL, ONE PER OWNER: the commit log and the
 * mirror carry `'REDACTED'` (`LOG_PLACEHOLDER`, `memory/placeholders.ts` — a
 * record byte, written by `memory/scrub.ts`); every scope-tier view — scope
 * recorder events, `stageReads`/`stageWrites`, narrative — carries
 * `'[REDACTED]'` ({@link SCOPE_PLACEHOLDER}, below — the verdict's own).
 * Neither string changed in 9.19.0 or since; each is spelled once in `src/`.
 */

import { nativeHas } from 'foottrace/paths';
import type { WriteScrub, WriteVerb } from 'foottrace/write';

import { isDevMode } from '../devMode.js';
import type { StructuredErrorInfo } from '../errors/errorInfo.js';
import { extractErrorInfo, thrownText } from '../errors/errorInfo.js';
import type { RedactionMarks } from '../pause/types.js';
import { RUN_NAMESPACE } from './runAddress.js';

/**
 * What the SCOPE CHANNEL carries where a value was scrubbed: a scope recorder's read, write and
 * commit events, the `stageReads` / `stageWrites` retention, the narrative, a decision's evidence, an
 * emit payload matched by `emitPatterns`, a pause payload's served form and a subflow's narrated seed
 * (`onSubflowEntry`) — every value this verdict serves, unless its caller passes the log's string.
 *
 * Its twin is the RECORD's `LOG_PLACEHOLDER` (`'REDACTED'`, `memory/placeholders.ts`): the commit log,
 * the redacted mirror and everything served from them. So NOT every recorder event carries this one:
 * `onSubflowExit.outputState` serves the subflow's redacted mirror when a policy keeps one, and so
 * carries the log's string (without a mirror — per-call marks alone — it is the subflow's heap
 * retained under the rule, with this one). Both strings are historical and neither changed when it
 * moved: this one was the constant `REDACTED` in this file until F4a, then `placeholders.ts ·
 * SCOPE_PLACEHOLDER`, and since C4 it lives here again, beside the verdict that writes it.
 */
export const SCOPE_PLACEHOLDER = '[REDACTED]';

/**
 * Declarative key/path redaction for recorded state and boundary records.
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
   * Diagnostic-only selectors, IN ADDITION to the state selectors above (which
   * already cover a diagnostic entry by its name: `keys: ['token']` masks
   * `$debug('token', …)`). Use these for names you mask in diagnostics but
   * not in state. Paths start with logs/errors/metrics/evals, e.g.
   * `logs.profile.token`. Only flowMessages.description and
   * flowMessages.rationale are payloads; flow topology/timing metadata stays
   * intact. Applied before retention, not retroactively to existing bags.
   */
  diagnostics?: Pick<RedactionPolicy, 'keys' | 'patterns' | 'fields'>;
  /**
   * Regex patterns matched against `EmitEvent.name` for `scope.$emit(...)`
   * calls. Any emit event whose name matches has its payload replaced with
   * the string `'[REDACTED]'` before dispatch to recorders.
   * Global/sticky patterns start at index zero on every test; their flags
   * retain their usual meaning. This does not scrub diagnostic side bags.
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
 * State redaction report. Never includes values; emit and diagnostic
 * selectors/activity are not represented here.
 */
export interface RedactionReport {
  /** Keys fully redacted (exact match or pattern match). */
  redactedKeys: string[];
  /** Keys with field-level redaction → which fields were scrubbed. */
  fieldRedactions: Record<string, string[]>;
  /** Pattern sources that were active (e.g. ['password|secret']). */
  patterns: string[];
}

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
 * The user-level NAME of `key` under `path` — the key itself at the top level, else the segments
 * joined by a dot (`['profile'] + 'auth'` → `'profile.auth'`): what a verdict decides on, a mark
 * holds, and the frame keys a stage's retained reads and writes by (`StageContext`). A name, not an
 * address — a key may contain a dot — so it never goes into a trace path. No allocation for the
 * common top-level key. (The record spells the same name for `readKeys`, `RecordFrame · noteRead`.)
 */
export function userKeyOf(path: readonly string[], key: string): string {
  return path.length > 0 ? [...path, key].join('.') : key;
}

/**
 * Maximum key length (characters) that will be tested against regex redaction
 * patterns. Keys longer than this are skipped for pattern matching to prevent
 * ReDoS: a pathological regex tested against an unboundedly long key string
 * can cause catastrophic backtracking. 256 characters comfortably exceeds any
 * realistic scope-state key name.
 */
const MAX_PATTERN_KEY_LEN = 256;

/**
 * The fields a policy declares under `key` — only when `fields` OWNS `key`.
 * The key is a name from data (a state key, a nested key of a record handed
 * out whole), and a plain-object lookup reads the prototype chain:
 * `fields['constructor']` is `Object`, `fields['__proto__']` is
 * `Object.prototype`. The walk then iterated them, so any `fields` policy
 * failed the run with a TypeError on data holding such a key.
 */
function declaredFields(fields: Record<string, string[]> | undefined, key: string): readonly string[] | undefined {
  return fields !== undefined && Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : undefined;
}

/** Policy patterns are predicates, not cursors over successive keys/events. */
function matchesPattern(value: string, patterns: readonly RegExp[] | undefined): boolean {
  if (!patterns) return false;
  for (const pattern of patterns) {
    // Only these flags consume lastIndex. Ordinary (including frozen)
    // regexes need no writable cursor to match. Keep all original flags.
    if (pattern.global || pattern.sticky) pattern.lastIndex = 0;
    if (pattern.test(value)) return true;
  }
  return false;
}

export class RedactionRule {
  private policy: RedactionPolicy | undefined;
  private diagnosticRule: RedactionRule | undefined;
  /** Whether `policy` names anything a state verdict can act on — computed
   *  once per `setPolicy` so {@link isInert} is a two-field check. */
  private policyActive = false;
  /** The policy's patterns that can depend on a whole dotted path ({@link needsPath}) — per `setPolicy`. */
  private pathPatterns: readonly RegExp[] = [];
  private walkLimitWarned = false;
  /**
   * Keys marked secret for the rest of the run — by a per-call
   * `setValue(key, value, true)`, or by any write the policy redacted whole.
   * ONE set per run, shared by every scope and context (the executor builds
   * the rule once per run and installs it on the runtime root).
   */
  private marked: Set<string>;
  /**
   * Fields a subflow mapper handed to a NEW key along with the value they
   * belong to — target key → the source key's field paths (an object copied
   * by reference from a `fields`-selected key; {@link MapperTaint}).
   * Run-wide, by name, like {@link marked}.
   */
  private inherited: Map<string, readonly string[]> | undefined;
  /** This run's thrown values served masked (their text selected, or a selected key inside them) → their served form. */
  private maskedErrors: Map<unknown, StructuredErrorInfo> | undefined;

  constructor(policy?: RedactionPolicy, marked?: Set<string>) {
    this.marked = marked ?? new Set<string>();
    this.setPolicy(policy);
  }

  getPolicy(): RedactionPolicy | undefined {
    return this.policy;
  }

  setPolicy(policy: RedactionPolicy | undefined): void {
    this.policy = policy;
    const diagnostics = policy?.diagnostics;
    this.diagnosticRule = diagnostics
      ? new RedactionRule({ keys: diagnostics.keys, patterns: diagnostics.patterns, fields: diagnostics.fields })
      : undefined;
    this.pathPatterns = (policy?.patterns ?? []).filter(needsPath);
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
    return this.marked.size === 0 && !this.policyActive && this.inherited === undefined;
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

  /** Deleting a key clears its per-call mark and any fields a mapper gave it; a policy verdict survives it. */
  unmark(key: string): void {
    this.marked.delete(key);
    if (this.inherited?.delete(key) && this.inherited.size === 0) this.inherited = undefined;
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
    return matchesPattern(key, patterns);
  }

  /**
   * Retain an emitted payload BEFORE dispatch/capture. Emit names are not
   * state paths: no key-length cap, marks or field scrub applies here.
   * A clear payload keeps its identity; diagnostic bags are untouched.
   */
  retainEmit(name: string, payload: unknown): unknown {
    return matchesPattern(name, this.policy?.emitPatterns) ? SCOPE_PLACEHOLDER : payload;
  }

  /**
   * Retain a NAMED diagnostic entry — `address` is `[channel, ...path, name]`
   * (`$debug('token', v)` → `['logs', 'token']`; `$log(v)` → `['logs',
   * 'messages']`). THE MAPPING: the entry is the record `{ [name]: value }`
   * handed out whole, so it is retained as a boundary record holding the
   * state key `name` would be — the state verdict at `[...path, name]` (keys,
   * patterns and marks at every dotted prefix and at the name itself; the top
   * key's `fields`), then every nested own key whose name or dotted path is
   * selected ({@link retainBoundary}'s walk). The channel takes no part:
   * `logs.token`, `errors.token` and `metrics.token` are all the state key
   * `token`. `policy.diagnostics` (diagnostic-only selectors, rooted at the
   * channel) applies on top. Clear values keep their identity.
   */
  retainDiagnostic(address: readonly string[], value: unknown): unknown {
    const kept = this.isInert() ? value : this.retainNamed(address.slice(1), value);
    return this.diagnosticRule ? this.diagnosticRule.retain(address, kept) : kept;
  }

  /**
   * Retain flow-message text (`flowMessages.description` / `.rationale`): text
   * the engine composes has no name of its own, so no state selector reaches
   * it — only `policy.diagnostics` selects it.
   */
  retainFlowText(address: readonly string[], text: string): string {
    return this.diagnosticRule ? (this.diagnosticRule.retain(address, text) as string) : text;
  }

  /** {@link retainDiagnostic}'s state half: the value named by `path` (its last segment), served whole. */
  private retainNamed(path: readonly string[], value: unknown): unknown {
    if (path.length === 0) return value;
    const name = path[path.length - 1];
    const verdict: RedactionVerdict =
      path.length > 1 && this.isKeyRedacted(name) ? { kind: 'whole', key: name } : this.verdict(path);
    if (verdict.kind === 'whole') return SCOPE_PLACEHOLDER;
    const kept = RedactionRule.apply(verdict, value);
    if (kept === null || typeof kept !== 'object') return kept;
    const base = path.join('.');
    return servedByPath(kept, base, this.dottedTargets(base), this.namesWalk(false), SCOPE_PLACEHOLDER);
  }

  /**
   * The served form of a thrown value, decided ONCE at its error site from the
   * text the diagnostic collector retained for `errors.stageExecutionError`
   * (`kept`) and from the value itself — a record handed out whole, masked
   * when one of its own keys, at any depth, carries a selected name.
   * Unmasked: today's structured info. Masked: the error's `name`/`code` kept,
   * no `issues` (they quote the input) and no `raw` error (it holds the text
   * and the keys); the message is the placeholder when the text was selected,
   * the text itself when only a key was — remembered so `onRunFailed`, the
   * logger and a fork envelope serve the same form ({@link servedError}). The
   * thrown value itself stays real.
   */
  retainStageError(
    error: unknown,
    text: string,
    kept: unknown,
  ): { message: string; structuredError: StructuredErrorInfo } {
    const info = extractErrorInfo(error);
    const textSelected = kept !== text;
    if (!textSelected && !this.carriesSelectedKey(error)) return { message: text, structuredError: info };
    const message = textSelected ? String(kept) : text;
    const masked: StructuredErrorInfo = {
      message: textSelected ? message : info.message,
      ...(info.name !== undefined && { name: info.name }),
      ...(info.code !== undefined && { code: info.code }),
      raw: undefined,
    };
    (this.maskedErrors ??= new Map()).set(error, masked);
    return { message, structuredError: masked };
  }

  /**
   * Does a thrown value carry a selected name — an own key, at any depth, that
   * the policy or a mark selects? Total: a value whose keys cannot be read is
   * served masked (the safe side), never a second throw from an error path.
   */
  private carriesSelectedKey(value: unknown): boolean {
    if (this.isInert() || value === null || typeof value !== 'object') return false;
    try {
      return this.thrownCarries(value, new Set());
    } catch {
      // Keys that cannot be read (a throwing getter, a revoked Proxy) or a walk past its
      // limit: served in the masked form — its text kept, no `raw`.
      return true;
    }
  }

  /**
   * One thrown value and what a logger or a serializer prints with it: its own
   * keys at every depth, and its `cause` / an `AggregateError`'s `errors` — own
   * NON-enumerable keys no key walk sees — each walked the same way (a cycle
   * among them is followed once).
   */
  private thrownCarries(value: object, seen: Set<object>): boolean {
    if (seen.has(value)) return false;
    seen.add(value);
    if (selectsByPath(value, undefined, this.dottedTargets(undefined), this.namesWalk(false), new Map(), 0).selected) {
      return true;
    }
    const own = (key: string): unknown =>
      Object.prototype.hasOwnProperty.call(value, key) ? (value as Record<string, unknown>)[key] : undefined;
    const errors = own('errors');
    for (const part of [own('cause'), ...(Array.isArray(errors) ? errors : [])]) {
      if (part !== null && typeof part === 'object' && this.thrownCarries(part, seen)) return true;
    }
    return false;
  }

  /**
   * The key-level rules as the path walk asks them ({@link servedByPath}): a
   * nested key is selected by its own NAME (marks, keys, patterns), and — under
   * patterns only — by its dotted path; a declared (or inherited) field below a
   * key of its name is a target. Dotted keys and marks are TARGETS from the
   * walk's root ({@link dottedTargets}), so without patterns no decision
   * depends on the path and the walk shares them per object (linear on a DAG).
   * `rootDecided`: the root's own keys were already decided (`retainRecord`).
   */
  private namesWalk(rootDecided: boolean): Walk {
    const byPath = this.pathPatterns;
    return {
      names: {
        masks: (name) => this.isKeyRedacted(name),
        ...(byPath.length > 0 && {
          pathMasks: (path: string) => path.length <= MAX_PATTERN_KEY_LEN && matchesPattern(path, byPath),
        }),
        fields: (name) => this.fieldsOf(name),
      },
      rootDecided,
      ...(byPath.length === 0 && { memo: new WeakMap<object, Map<string, unknown>>() }),
      budget: walkLimit,
      onLimit: () => this.warnWalkLimit(byPath),
    };
  }

  /** Once per rule, in dev mode: a path walk passed its limit and served its remainder as the placeholder. */
  private warnWalkLimit(patterns: readonly RegExp[]): void {
    if (this.walkLimitWarned || !isDevMode()) return;
    this.walkLimitWarned = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[footprint] RedactionPolicy: a value with more than ${walkLimit} paths under the path pattern(s) ` +
        `${patterns.map(String).join(', ')} — the paths past that were served as the placeholder. ` +
        'A pattern that names a KEY (no dot, no lookaround) is decided per object; prefer one, or keys/fields.',
    );
  }

  /**
   * The dotted keys and marks that name a path under `base` (the walk's root:
   * `undefined` for a record's own keys, an entry's name for a diagnostic),
   * as targets relative to it — a dotted rule is exact to its path.
   */
  private dottedTargets(base: string | undefined): Target[] {
    const prefix = base === undefined ? '' : `${base}.`;
    const out: Target[] = [];
    const add = (name: string) => {
      if (!name.includes('.') || !name.startsWith(prefix) || name.length === prefix.length) return;
      out.push(name.slice(prefix.length).split('.'));
    };
    for (const name of this.marked) add(name);
    for (const name of this.policy?.keys ?? []) add(name);
    return out;
  }

  /**
   * What any observer is served for a thrown value — retry, throttle, run
   * failure, a fork envelope, the logger: its remembered stage form, else the
   * same decision made now (and remembered), else its structured info.
   */
  servedError(error: unknown): StructuredErrorInfo {
    const masked = this.maskedError(error);
    // Each event gets its own object, as extractErrorInfo gives it one.
    return masked ? { ...masked } : extractErrorInfo(error);
  }

  /** What the logger is handed: the thrown value itself unless the policy masked its text. */
  loggableError(error: unknown): unknown {
    const masked = this.maskedError(error);
    return masked ? { ...masked } : error;
  }

  private maskedError(error: unknown): StructuredErrorInfo | undefined {
    const known = this.maskedErrors?.get(error);
    if (known || this.isDiagnosticInert()) return known;
    const text = thrownText(error);
    this.retainStageError(error, text, this.retainDiagnostic(['errors', 'stageExecutionError'], text));
    return this.maskedErrors?.get(error);
  }

  /**
   * Nothing can mask a diagnostic entry or a thrown value — no state selector,
   * no mark, no diagnostic selector: the collectors' and the error paths' fast
   * path (a no-policy run never reads a payload, including borrowed getters).
   */
  isDiagnosticInert(): boolean {
    return this.isInert() && this.isFlowTextInert();
  }

  /** Nothing can mask flow-message text — only `policy.diagnostics` selects it ({@link retainFlowText}). */
  isFlowTextInert(): boolean {
    return !this.diagnosticRule || this.diagnosticRule.isInert();
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
    const fields = this.fieldsOf(path[0]);
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

  /** The single-segment verdict: key-level hit → whole; declared or inherited fields → fields. */
  private verdictOfKey(key: string): RedactionVerdict {
    if (this.isKeyRedacted(key)) return { kind: 'whole', key };
    const fields = this.fieldsOf(key);
    return fields !== undefined && fields.length > 0 ? { kind: 'fields', key, paths: fields } : CLEAR;
  }

  /** The secret fields of a top key: the policy's, plus any a mapper handed it ({@link MapperTaint}). */
  private fieldsOf(key: string): readonly string[] | undefined {
    const declared = declaredFields(this.policy?.fields, key);
    const inherited = this.inherited?.get(key);
    if (inherited === undefined) return declared;
    return declared === undefined ? inherited : [...new Set([...declared, ...inherited])];
  }

  /**
   * The run's marks and the fields mappers handed to new keys, as NAMES — what
   * a pause carries to the resumed run (`FlowchartCheckpoint.redactionMarks`).
   * `undefined` when there are none (no policy, no per-call mark).
   */
  marksForCheckpoint(): RedactionMarks | undefined {
    if (this.marked.size === 0 && this.inherited === undefined) return undefined;
    return {
      keys: [...this.marked],
      ...(this.inherited !== undefined && {
        fields: Object.fromEntries([...this.inherited].map(([key, paths]) => [key, [...paths]])),
      }),
    };
  }

  /** Seed a resumed run's rule with the marks its pause carried ({@link marksForCheckpoint}). */
  restoreMarks(marks: RedactionMarks): void {
    for (const key of marks.keys) this.marked.add(key);
    for (const [key, paths] of Object.entries(marks.fields ?? {})) this.inheritFields(key, paths);
  }

  /**
   * A subflow mapper's copy inherits the fields of the value it copied:
   * `target` is a key the mapper wrote; `paths` the source key's field paths
   * (declared or themselves inherited). Run-wide, by name, like a mark.
   */
  inheritFields(target: string, paths: readonly string[]): void {
    const prior = this.inherited?.get(target) ?? [];
    (this.inherited ??= new Map()).set(target, [...new Set([...prior, ...paths])]);
  }

  /** The verdict of a key a mapper read — `runs` (the run namespaces, `RUN_NAMESPACE`) is selected when any namespaced key is. */
  verdictOfRead(key: string, value: unknown): RedactionVerdict {
    const verdict = this.verdictOfKey(key);
    if (verdict.kind !== 'clear' || key !== RUN_NAMESPACE || value === null || typeof value !== 'object') {
      return verdict;
    }
    for (const space of Object.values(value)) {
      if (space === null || typeof space !== 'object') continue;
      for (const inner of Object.keys(space)) {
        if (this.verdictOfKey(inner).kind !== 'clear') return { kind: 'whole', key };
      }
    }
    return verdict;
  }

  /**
   * The retained / served form of a value at a path: the placeholder, a
   * scrubbed CLONE, or the value itself (same reference — recorders receive
   * borrowed live references for clear values, as they always have).
   * `placeholder` defaults to the scope-tier `'[REDACTED]'`; the mirror seed
   * passes the log's `'REDACTED'`.
   */
  retain(path: readonly string[], value: unknown, placeholder: string = SCOPE_PLACEHOLDER): unknown {
    return RedactionRule.apply(this.verdict(path), value, placeholder);
  }

  /**
   * The retained form of a STATE record (state read, mirror seed): each own
   * enumerable string key through {@link retain}. Fields are paths inside that
   * keyed value. Scalars and root arrays pass through. Boundary records add
   * the nested-key walk: {@link retainBoundary}.
   * Returns the SAME object when unchanged. An inert rule does not enumerate
   * the value, so even an accessor is untouched on the no-policy fast path.
   */
  retainRecord<T>(record: T, placeholder: string = SCOPE_PLACEHOLDER): T {
    if (this.isInert() || record === null || typeof record !== 'object' || Array.isArray(record)) return record;
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
   * The retained form of a BOUNDARY record — root input/output and a subflow's
   * mapped seed, before any observer sees it. {@link retainRecord} decides each
   * top key; then every NESTED own key is a key too: secret when its own name
   * or its dotted path is redacted at key level (`keys: ['secret']` covers
   * `{ wrapper: { secret } }`; a root array's elements are walked the same
   * way), and its declared `fields` scrubbed inside it (`fields: { profile:
   * ['token'] }` covers `{ wrapper: { profile: { token } } }`). Decided per
   * PATH, copy-on-write per path ({@link servedByPath}): an object shared by
   * two paths is masked at the one a path rule names and served as it is at
   * the other; a cycle edge lands on the served copy, never on an unscrubbed
   * original; the live value is never touched. Returns the SAME object when
   * nothing nested is secret, and an inert rule enumerates nothing. State
   * keeps its own path verdicts ({@link verdict}); this walk is for records
   * handed out whole.
   */
  retainBoundary<T>(record: T, placeholder: string = SCOPE_PLACEHOLDER): T {
    // A masked stage error inside the record (a fork envelope's `result`) is
    // served in its masked form: an Error's message is non-enumerable and a
    // thrown string is a plain value, so no key walk sees either.
    const served = this.maskedErrors?.size ? (this.withServedErrors(record) as T) : record;
    if (this.isInert() || served === null || typeof served !== 'object') return served;
    const top = this.retainRecord(served, placeholder) as unknown as object;
    // Below the top keys, one decision per PATH (the whole record is the walk's root, so a cycle
    // back to it lands on the served copy).
    return servedByPath(top, undefined, this.dottedTargets(undefined), this.namesWalk(true), placeholder) as T;
  }

  /**
   * Copy-on-write over containers: every remembered masked error becomes its
   * served form — an object error its masked structured info, a thrown
   * string/number its masked text (the value keeps being a scalar). A scalar is
   * matched by VALUE, so an unrelated field that happens to equal a masked
   * thrown string is masked too: over-masking is the safe direction.
   * `undefined`/`null`/booleans are never swapped — they carry no text, and
   * swapping them would rewrite ordinary data shapes.
   *
   * CYCLE-SAFE (review finding 2). The containers that can REACH a masked
   * error are found first ({@link reachingMaskedErrors} — the whole reachable
   * graph, cycles included); each of them is copied, its copy allocated and
   * remembered BEFORE its children are filled, so an edge back to it — a cycle
   * — lands on the copy, never on the original that still holds the raw error.
   * Every other container keeps its identity.
   */
  private withServedErrors(value: unknown): unknown {
    const leaf = this.servedLeaf(value);
    if (leaf !== KEEP || value === null || typeof value !== 'object') return leaf === KEEP ? value : leaf;
    const reaching = this.reachingMaskedErrors(value);
    if (!reaching.has(value)) return value;
    const copies = new Map<object, Record<string, unknown>>();
    const copyOf = (node: object): Record<string, unknown> => {
      const known = copies.get(node);
      if (known !== undefined) return known;
      const copy = (Array.isArray(node) ? node.slice() : { ...node }) as Record<string, unknown>;
      copies.set(node, copy);
      for (const [key, child] of Object.entries(node)) {
        const served = this.servedLeaf(child);
        if (served !== KEEP) copy[key] = served;
        else if (child !== null && typeof child === 'object' && reaching.has(child)) copy[key] = copyOf(child);
      }
      return copy;
    };
    return copyOf(value);
  }

  /** A masked error's served form — `KEEP` for anything else (a scalar never swapped, a container). */
  private servedLeaf(value: unknown): unknown {
    if (value === null || value === undefined || typeof value === 'boolean') return KEEP;
    if (typeof value === 'object') {
      const masked = this.maskedErrors?.get(value);
      return masked ? { ...masked } : KEEP;
    }
    const swappable = typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint';
    const masked = swappable ? this.maskedErrors?.get(value) : undefined;
    return masked ? masked.message : KEEP;
  }

  /** Every container under `root` (itself included) from which some path reaches a masked error. */
  private reachingMaskedErrors(root: object): Set<object> {
    const parents = new Map<object, object[]>();
    const holders: object[] = [];
    const seen = new Set<object>([root]);
    const stack: object[] = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      for (const child of Object.values(node)) {
        if (this.servedLeaf(child) !== KEEP) {
          holders.push(node);
          continue;
        }
        if (child === null || typeof child !== 'object') continue;
        const of = parents.get(child);
        if (of === undefined) parents.set(child, [node]);
        else of.push(node);
        if (!seen.has(child)) {
          seen.add(child);
          stack.push(child);
        }
      }
    }
    const reaching = new Set<object>();
    while (holders.length > 0) {
      const node = holders.pop()!;
      if (reaching.has(node)) continue;
      reaching.add(node);
      holders.push(...(parents.get(node) ?? []));
    }
    return reaching;
  }

  /** Does `value` hold one of `paths` — an own key of that name, or a dotted path inside it? */
  static holdsPaths(value: object, paths: readonly string[] | undefined): boolean {
    if (paths === undefined) return false;
    for (const path of paths) {
      if (Object.prototype.hasOwnProperty.call(value, path) || (path.includes('.') && nativeHas(value, path))) {
        return true;
      }
    }
    return false;
  }

  /**
   * The retained form of a whole STATE — {@link retainRecord} over the root
   * keys AND over every run namespace under `runs` (fork children write
   * there; a checkpoint's `sharedState` carries it back as a seed). This is
   * what seeds the redacted mirror: the store's starting state, scrubbed
   * with the log's placeholder, so a policy key that arrives by seed and is
   * never re-written is still served as the placeholder.
   */
  retainState<T>(state: T, placeholder: string = SCOPE_PLACEHOLDER): T {
    const kept = this.retainRecord(state, placeholder);
    if (kept === null || typeof kept !== 'object') return kept;
    const runs = (kept as Record<string, unknown>)[RUN_NAMESPACE];
    if (runs === null || typeof runs !== 'object' || Array.isArray(runs)) return kept;
    let scrubbedRuns: Record<string, unknown> | undefined;
    for (const [runId, record] of Object.entries(runs as Record<string, unknown>)) {
      const keptRun = this.retainRecord(record, placeholder);
      if (keptRun === record) continue;
      scrubbedRuns ??= { ...(runs as Record<string, unknown>) };
      scrubbedRuns[runId] = keptRun;
    }
    return scrubbedRuns === undefined ? kept : ({ ...(kept as object), [RUN_NAMESPACE]: scrubbedRuns } as T);
  }

  /** Apply a verdict to a value — see {@link retain}. */
  static apply(verdict: RedactionVerdict, value: unknown, placeholder: string = SCOPE_PLACEHOLDER): unknown {
    if (verdict.kind === 'whole') return placeholder;
    if (verdict.kind === 'fields') return RedactionRule.scrubFields(value, verdict.paths, placeholder) ?? value;
    return value;
  }

  /**
   * A deep clone of `value` with the given dot-paths replaced by the
   * placeholder — `undefined` when `value` is not an object (there is nothing
   * to scrub in a scalar; the caller keeps the value). The clone refuses an
   * uncloneable value. A path names a literal key (`'a.b'` as one property)
   * and, when dotted, the nested path; each is scrubbed where it exists, per
   * PATH — a node the clone shares between two paths is masked at the named
   * one only ({@link servedByPath}). Paths that do not exist are ignored —
   * scrubbing never invents a field.
   */
  static scrubFields(
    value: unknown,
    paths: readonly string[],
    placeholder: string = SCOPE_PLACEHOLDER,
  ): Record<string, unknown> | undefined {
    if (value === null || typeof value !== 'object') return undefined;
    // The clone detaches the retained value (and refuses an uncloneable one); the scrub on it is
    // decided per PATH, so a node the clone shares between two paths is masked at the named one only.
    const copy = structuredClone(value) as object;
    return servedByPath(
      copy,
      undefined,
      targetsOf(paths),
      { rootDecided: false, memo: new WeakMap<object, Map<string, unknown>>(), budget: walkLimit },
      placeholder,
    ) as Record<string, unknown>;
  }

  report(): RedactionReport {
    // Keyed by a Map, then made own data keys by `fromEntries`: a key a mapper
    // wrote is a name from data, and on a plain object `toString` would read
    // the inherited method and `__proto__` would call the prototype setter.
    const fieldRedactions = new Map<string, string[]>();
    for (const [key, fields] of Object.entries(this.policy?.fields ?? {})) {
      fieldRedactions.set(key, [...fields]);
    }
    // Fields a mapper handed to a new key are scrubbed under that key too.
    for (const [key, fields] of this.inherited ?? []) {
      fieldRedactions.set(key, [...new Set([...(fieldRedactions.get(key) ?? []), ...fields])]);
    }
    return {
      redactedKeys: [...this.marked],
      fieldRedactions: Object.fromEntries(fieldRedactions),
      patterns: (this.policy?.patterns ?? []).map((p) => p.source),
    };
  }
}

// ─── The write decision — one per staged write (C4) ─────────────────────────
//
// What the run's rule says about one staged write, and what the write leaves on the rule. Every staged
// write passes `StageContext · stageWrite` (the one funnel: facade writes, a subflow seed, an
// `outputMapper` merge-back, a resume re-seed), which runs the four steps in the order the record needs:
//
//   1. VERDICT  `decideWrite` — an explicit per-call flag, else the rule that is ACTIVE as the write begins.
//   2. IDENTITY `inheritByIdentity` — with the frame's selected reads AS THEY STAND after step 1: a policy
//               pattern is user code, and it can read on the very frame that is writing.
//   3. BYTES    the caller: `RecordFrame · write(path, value, verb, scrubOf(verdict))`. The record writes
//               them; it never decides them.
//   4. MARKS    `markStagedWrite` — only once the write staged: a write that fails to stage marks nothing.
//
// Steps 1–2 and step 4 are calls around the write, not one call before it, and each reads the rule when
// it acts — as the funnel always did, so user code that runs DURING a write (a getter on the value, a
// pattern's `test`) finds the same rule, and leaves the same marks, as before C4.

/**
 * Step 1 — THE VERDICT for one staged write: an explicit per-call flag (`setValue(key, value, true)`)
 * makes the value secret whole under its user-level key; else the `active` rule decides from the
 * user-level path; with none (no rule, or an inert one — the caller passes `undefined`), clear, with no
 * verdict call and no path allocation (the no-policy fast path). Marks nothing.
 *
 * ```ts
 * decideWrite(new RedactionRule({ fields: { card: ['number'] } }), [], 'card', false); // { kind: 'fields', key: 'card', paths: ['number'] }
 * decideWrite(undefined, ['profile'], 'auth', true); // { kind: 'whole', key: 'profile.auth' }
 * ```
 */
export function decideWrite(
  active: RedactionRule | undefined,
  path: readonly string[],
  key: string,
  explicit: boolean | undefined,
): RedactionVerdict {
  if (explicit) return { kind: 'whole', key: userKeyOf(path, key) };
  return active !== undefined ? active.verdictAt(path, key) : CLEAR;
}

/**
 * Step 2 — IDENTITY: an OBJECT the stage read under a selected name (`selected` — the frame's selected
 * reads, filled by its tracked reads), written under another name (`s.person = s.profile`), keeps that
 * read's rule, matched by identity: a whole read marks the new key, a `fields` read hands it the fields
 * (re-based under the written path), and the verdict is asked again. A new object, a primitive, or a
 * write already whole is selected by its own name only — `verdict` comes back as it is. Decided BEFORE
 * the write, because the verdict needs it: an inheritance stays even if the write then fails to stage.
 */
export function inheritByIdentity(
  active: RedactionRule | undefined,
  verdict: RedactionVerdict,
  selected: WeakMap<object, RedactionVerdict> | undefined,
  path: readonly string[],
  key: string,
  value: unknown,
): RedactionVerdict {
  const read =
    active !== undefined && verdict.kind !== 'whole' && value !== null && typeof value === 'object'
      ? selected?.get(value)
      : undefined;
  if (read === undefined || active === undefined) return verdict;
  if (read.kind === 'whole') active.mark(userKeyOf(path, key));
  else if (read.kind === 'fields') {
    const at = [...path.slice(1), ...(path.length > 0 ? [key] : [])];
    active.inheritFields(
      path[0] ?? key,
      read.paths.map((field) => [...at, field].join('.')),
    );
  }
  return active.verdictAt(path, key);
}

/** The scrub of a whole verdict — one frozen object for every write it covers. */
const WHOLE_SCRUB: WriteScrub = Object.freeze({ whole: true });

/**
 * Step 3's input — a verdict's BYTES for the record (`RecordFrame · write`): nothing when clear, the
 * whole value, or the fields inside it. No allocation on the default path (clear) or for a whole verdict.
 */
export function scrubOf(verdict: RedactionVerdict): WriteScrub | undefined {
  if (verdict.kind === 'whole') return WHOLE_SCRUB;
  return verdict.kind === 'fields' ? { fields: verdict.paths } : undefined;
}

/**
 * Step 4 — the MARKS a staged write leaves; call it only once the write staged, so a write that fails to
 * stage marks nothing. A delete clears its key's mark (and any fields a mapper handed it) on `active`,
 * the rule that was active as the write BEGAN — none when it was inert, even if user code marked the key
 * during the write. A whole verdict marks its key — the key that DECIDED it (`verdict.key`: an ancestor
 * for a nested write under a whole-selected key) — for the rest of the run on `rule`, the run's rule as
 * it stands NOW (user code during the write may have installed one; an explicit mark is what makes an
 * inert rule active). A mark is a run-wide NAME: it stays when the stage's commit fails or a retry
 * discards the attempt — the safe side; only a staged delete removes one.
 */
export function markStagedWrite(
  active: RedactionRule | undefined,
  rule: RedactionRule | undefined,
  verdict: RedactionVerdict,
  path: readonly string[],
  key: string,
  verb: WriteVerb,
): void {
  if (verb === 'delete') active?.unmark(userKeyOf(path, key));
  else if (verdict.kind === 'whole') rule?.mark(verdict.key);
}

// ─── The path walk — one decision per PATH ─────────────────────────────────
//
// A rule that names a PATH (a dotted key, a pattern, a field) must be exact
// even when one object is reachable at two paths: the decision is made per
// path, never per object, and a copy is made per path (copy-on-write) — never
// a scrub in place on a node another path still shows. A key-NAME rule is the
// same at every path, so a shared node it masks is masked everywhere — the
// safe side. A cycle edge is not followed: it is pointed at the ancestor's
// served copy.
//
// LINEAR ON A DAG. Dotted keys and marks are walked as TARGETS (path-relative
// state, like fields), and a pattern that can only match within a key NAME
// ({@link needsPath} — the common case, `/password/i`) is decided by the name,
// so a decision depends only on the object and the targets still live at it —
// memoized per (object, targets): an object shared by many paths (an agent's
// linked history) is decided once, and its served copy is shared too. Only a
// genuinely PATH-dependent pattern (`/^a\.b$/`) walks paths; past
// {@link WALK_LIMIT} path visits such a walk serves the unvisited remainder as
// the placeholder (the safe side), warns once in dev mode, and never fails.

/** A field still to reach below a node: the path segments left to walk. */
type Target = readonly string[];

/** How a walk decides an edge. */
interface Walk {
  /** Key-level rules at every nested key — absent for a bare field scrub (targets only). */
  readonly names?: {
    /** Selected whole at this nested key by its own NAME (marks, keys, patterns). */
    masks(name: string): boolean;
    /** Selected whole by the dotted PATH — present only under patterns (a pattern is tested on the path). */
    pathMasks?(path: string): boolean;
    /** The declared fields below a key of this name. */
    fields(name: string): readonly string[] | undefined;
  };
  /** The root's own keys were decided by the caller (`retainRecord`): walk below them only. */
  readonly rootDecided: boolean;
  /** Decisions shared per (object, targets) — absent when a decision depends on the path. */
  readonly memo?: WeakMap<object, Map<string, unknown>>;
  /** Path visits left. */
  budget: number;
  /** Told once when the walk passes its limit. */
  readonly onLimit?: () => void;
  /** The walk has passed its limit: what it has not visited is served as the placeholder. */
  limited?: boolean;
}

/**
 * Path visits one walk may make — reachable only under a PATH-dependent
 * pattern over a value whose paths outnumber its objects (a linked history, a
 * DAG): every other walk shares its decisions per object and stays linear.
 */
export const WALK_LIMIT = 1_000_000;

/** The limit walks use: {@link WALK_LIMIT}, unless a test lowered it ({@link useWalkLimit}). */
let walkLimit: number = WALK_LIMIT;

/**
 * @internal Tests only — not on any public door: walks use `limit` until the
 * returned restore is called, so a test reaches the over-limit path in a
 * thousand visits instead of a million.
 */
export function useWalkLimit(limit: number): () => void {
  const prior = walkLimit;
  walkLimit = limit;
  return () => {
    walkLimit = prior;
  };
}

/**
 * Can `pattern` match a dotted PATH where it matches none of the path's
 * segment NAMES? Only through a construct that can match or test the `.`
 * between segments: `.` itself, an escape that can stand for it (`\W \S \D
 * \B \p \P \u \x \c`, a digit escape), a negated class, a class range that
 * spans `.`, a lookaround or a named group. Anything else matches a path only
 * inside one segment — and an ancestor whose NAME matches is masked whole
 * before the walk goes below it, so the name decides. Conservative: `true`
 * whenever in doubt.
 *
 * Linear in the length of `pattern.source`: every scan here is one forward
 * pass ({@link classBodies}) or a regex that does constant work per position.
 */
export function needsPath(pattern: RegExp): boolean {
  const source = pattern.source;
  if (/\.|\\[WSDBpPuxc0-9]|\[\^|\(\?[=!<]/.test(source)) return true;
  for (const body of classBodies(source)) {
    for (const [, low, high] of body.matchAll(/(\\?[\s\S])-(\\?[\s\S])/g)) {
      if (low.length > 1 || high.length > 1 || (low <= '.' && high >= '.')) return true;
    }
  }
  return false;
}

/**
 * The body of each character class in `source`, left to right: the text
 * between a `[` and the first `]` after it that no `\` escapes (a `\` takes
 * the character after it along). ONE forward pass.
 *
 * It replaces `source.matchAll(/\[((?:\\[\s\S]|[^\]\\])*)\]/g)` and gives the
 * same bodies for every string (pinned against that regex as the control,
 * test/lib/memory/security/needs-path-linear.security.test.ts). The regex was
 * quadratic: after a `[` that never closed it retried at every later `[`,
 * each retry rescanning to the end — `\[` repeated 32,000 times took 0.7 s,
 * and `setPolicy` runs once per stage's scope (CodeQL js/polynomial-redos).
 * The pass stops at the first `[` that never closes instead: a later `[`
 * starts its body where the failed scan was also between two tokens, so it
 * reads the same tail the same way and closes nowhere either.
 *
 * @internal Exported for that test only — not on any public door.
 */
export function classBodies(source: string): string[] {
  const bodies: string[] = [];
  let open = source.indexOf('[');
  while (open !== -1) {
    const close = closingBracket(source, open + 1);
    if (close === -1) break;
    bodies.push(source.slice(open + 1, close));
    open = source.indexOf('[', close + 1);
  }
  return bodies;
}

/** The index of the first `]` at or after `from` that no `\` escapes, else -1 (a trailing lone `\` escapes nothing and closes nothing). */
function closingBracket(source: string, from: number): number {
  let at = from;
  while (at < source.length) {
    const char = source[at];
    if (char === ']') return at;
    at += char === '\\' ? 2 : 1;
  }
  return -1;
}

/** `servedLeaf`'s answer for a value it leaves as it is. */
const KEEP: unique symbol = Symbol('kept as it is');

/** Each field path as one literal key and, when dotted, as its segments. */
function targetsOf(paths: readonly string[] | undefined): Target[] {
  const out: Target[] = [];
  for (const path of paths ?? []) {
    out.push([path]);
    if (path.includes('.')) out.push(path.split('.'));
  }
  return out;
}

/** The memo key of a target state — order-free. */
function signatureOf(targets: readonly Target[]): string {
  return targets.length === 0
    ? ''
    : targets
        .map((t) => t.join('\u001f'))
        .sort()
        .join('\u001e');
}

/** One edge's decision: the value under `key` is masked here, or these targets continue below it. */
function decideEdge(
  key: string,
  dotted: string | undefined,
  targets: readonly Target[],
  walk: Walk,
  depth: number,
): { masked: boolean; below: Target[] } {
  const below: Target[] = [];
  let masked = false;
  for (const target of targets) {
    if (target[0] !== key) continue;
    if (target.length === 1) masked = true;
    else below.push(target.slice(1));
  }
  const names = walk.rootDecided && depth === 0 ? undefined : walk.names;
  if (names !== undefined && !masked) {
    masked =
      names.masks(key) ||
      (names.pathMasks !== undefined && dotted !== undefined && names.pathMasks(`${dotted}.${key}`));
    below.push(...targetsOf(names.fields(key)));
  }
  return { masked, below };
}

/** One step down a walk's path: count the visit — `false` once the walk is past its limit. */
function visit(walk: Walk): boolean {
  if (--walk.budget >= 0) return true;
  if (!walk.limited) {
    walk.limited = true;
    walk.onLimit?.();
  }
  return false;
}

/**
 * Is anything selected on some PATH under `node`? Read-only; a cycle edge is
 * not followed. `back` is the shallowest ancestor a skipped cycle edge below
 * reached — a `false` that rests on one is not shared (memo).
 */
function selectsByPath(
  node: object,
  dotted: string | undefined,
  targets: readonly Target[],
  walk: Walk,
  ancestors: Map<object, number>,
  depth: number,
): { selected: boolean; back: number } {
  // Past the limit: assume a selection — the copy serves the unvisited remainder as the placeholder.
  if (!visit(walk)) return { selected: true, back: Infinity };
  if (walk.names === undefined && targets.length === 0) return { selected: false, back: Infinity };
  const sig = walk.memo ? signatureOf(targets) : '';
  const known = walk.memo?.get(node)?.get(`s${sig}`);
  if (known !== undefined) return { selected: known as boolean, back: Infinity };
  ancestors.set(node, depth);
  let back = Infinity;
  let selected = false;
  for (const [key, child] of Object.entries(node)) {
    const edge = decideEdge(key, dotted, targets, walk, depth);
    if (edge.masked) {
      selected = true;
      break;
    }
    if (child === null || typeof child !== 'object') continue;
    const at = ancestors.get(child);
    if (at !== undefined) {
      back = Math.min(back, at);
      continue;
    }
    const childPath = walk.names?.pathMasks ? (dotted === undefined ? key : `${dotted}.${key}`) : undefined;
    const below = selectsByPath(child, childPath ?? key, edge.below, walk, ancestors, depth + 1);
    back = Math.min(back, below.back);
    if (below.selected) {
      selected = true;
      break;
    }
  }
  ancestors.delete(node);
  if (walk.memo && (selected || back >= depth)) remember(walk.memo, node, `s${sig}`, selected);
  return { selected, back: back < depth ? back : Infinity };
}

function remember(memo: WeakMap<object, Map<string, unknown>>, node: object, key: string, value: unknown): void {
  let entries = memo.get(node);
  if (entries === undefined) memo.set(node, (entries = new Map()));
  entries.set(key, value);
}

/**
 * The served copy of `node`, copy-on-write PER PATH. Every container entered
 * gets its copy BEFORE its children are walked, so a cycle edge is pointed at
 * the ancestor's copy — never back at an unscrubbed original; a container is
 * served as itself when nothing under it changed and no cycle passes through
 * it. A pruned descent (a bare field scrub of an acyclic value) skips subtrees
 * no target reaches. `back` is the shallowest ancestor a cycle edge below
 * reached (`Infinity`: none); a copy that rests on none is shared (memo).
 */
function copyByPath(
  node: object,
  dotted: string | undefined,
  targets: readonly Target[],
  walk: Walk,
  placeholder: string,
  ancestors: Map<object, { copy: Record<string, unknown>; depth: number }>,
  depth: number,
  prune: boolean,
): { out: unknown; back: number } {
  // Past the limit: the unvisited remainder is served as the placeholder — never raw.
  if (!visit(walk)) return { out: placeholder, back: Infinity };
  const sig = walk.memo ? `c${signatureOf(targets)}` : '';
  const known = walk.memo?.get(node)?.get(sig);
  if (known !== undefined) return { out: known, back: Infinity };
  const frame = {
    copy: (Array.isArray(node) ? node.slice() : { ...node }) as Record<string, unknown>,
    depth,
  };
  ancestors.set(node, frame);
  let changed = false;
  let back = Infinity;
  for (const [key, child] of Object.entries(node)) {
    const edge = decideEdge(key, dotted, targets, walk, depth);
    if (edge.masked) {
      frame.copy[key] = placeholder;
      changed = true;
      continue;
    }
    if (child === null || typeof child !== 'object') continue;
    const ancestor = ancestors.get(child);
    if (ancestor !== undefined) {
      frame.copy[key] = ancestor.copy;
      back = Math.min(back, ancestor.depth);
      continue;
    }
    if (prune && edge.below.length === 0) continue;
    const childPath = walk.names?.pathMasks ? (dotted === undefined ? key : `${dotted}.${key}`) : key;
    const below = copyByPath(child, childPath, edge.below, walk, placeholder, ancestors, depth + 1, prune);
    if (below.out !== child) {
      frame.copy[key] = below.out;
      changed = true;
    }
    back = Math.min(back, below.back);
  }
  ancestors.delete(node);
  const out = changed || back <= depth ? frame.copy : node;
  if (walk.memo && back >= depth) remember(walk.memo, node, sig, out);
  return { out, back: back < depth ? back : Infinity };
}

/** Does any path from `root` come back to an object on it? */
function hasCycle(root: object): boolean {
  const done = new WeakSet<object>();
  const onPath = new Set<object>();
  const visitNode = (node: object): boolean => {
    if (onPath.has(node)) return true;
    if (done.has(node)) return false;
    onPath.add(node);
    for (const child of Object.values(node)) {
      if (child !== null && typeof child === 'object' && visitNode(child)) return true;
    }
    onPath.delete(node);
    done.add(node);
    return false;
  };
  return visitNode(root);
}

/**
 * The served form of `root` under a walk: `root` itself when no path selects
 * anything, else its copy-on-write copy (past the walk limit, its unvisited
 * remainder served as the placeholder). Throws — the caller refuses to serve
 * — on an enumerable getter that throws.
 */
function servedByPath(
  root: object,
  dotted: string | undefined,
  targets: readonly Target[],
  walk: Walk,
  placeholder: string,
): unknown {
  if (!selectsByPath(root, dotted, targets, walk, new Map(), 0).selected) return root;
  walk.budget = walkLimit;
  // A bare field scrub of an acyclic value walks its targets only: no cycle can bring an
  // unscrubbed original back. Every other walk visits every path (a cycle edge anywhere
  // must land on a served copy).
  const prune = walk.names === undefined && !hasCycle(root);
  return copyByPath(root, dotted, targets, walk, placeholder, new Map(), 0, prune).out;
}

/** A plain record — the only shape a mapper is handed as a recording view (a class instance keeps its prototype). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The stricter of two verdicts on the same value: whole over fields over clear; fields unite. */
function stricter(a: RedactionVerdict | undefined, b: RedactionVerdict): RedactionVerdict {
  if (a === undefined || a.kind === 'clear' || b.kind === 'whole') return b;
  if (a.kind === 'whole' || b.kind === 'clear') return a;
  return { kind: 'fields', key: a.key, paths: [...new Set([...a.paths, ...b.paths])] };
}

/**
 * THE TAINT RULE at a subflow mapper boundary (an `inputMapper` seeding a
 * subflow, an `outputMapper` merging it back): a key the mapper writes
 * inherits the redaction of the SELECTED value it copied — a mark (or
 * inherited fields), by name, like a per-call `setValue(key, value, true)` —
 * so the subflow's seed, log, mirror, reads, narrative and results, and the
 * parent's merge-back, retain the copy as they retain its source. Decided by
 * which values the mapper READ:
 *
 *   - SAME NAME — a value passed on under the name it was read under keeps
 *     that name's verdict (`{ count: p.count }`, `{ ...p }`): a clear value
 *     stays clear, wherever else the mapper read a secret.
 *   - EXACT — an output OBJECT that IS (by reference) a value the mapper read
 *     inherits that key's verdict: whole stays whole, `fields` hand their paths
 *     to the new key, clear stays clear. The record the mapper was HANDED,
 *     passed on whole (`(p) => ({ ctx: p })`), hands every selected key of it
 *     to the new key as a field (`ctx.token`).
 *   - CONSERVATIVE — any other output (a primitive under a new name, or an
 *     object the mapper built) is selected WHOLE when the mapper read a
 *     selected value — a whole-selected key, or a selected FIELD of a
 *     `fields`-selected record — or when it embeds a selected record by
 *     reference; the library cannot tell what a computed value carries.
 *     (Values are never matched by EQUALITY across names: an equal primitive
 *     would over-match unrelated keys.)
 *
 * HOW FAR A MARK REACHES: a NAME, run-wide, from the moment it is made — every
 * key of that name in the subflow, the parent, a sibling and every later stage
 * is selected in whatever is served, until the key is deleted; a pause carries
 * it to the resumed run (`FlowchartCheckpoint.redactionMarks`).
 *
 * A `fields`-selected record that holds a selected field is handed to the
 * mapper as a view of its own, so reading the record (to pass it on, or to
 * test its type) is not reading the field. Reading `runs` (the namespace root
 * fork children write under) reads every namespaced key. Recording stops when
 * the mapper returns; {@link inherit} hands back the output with every view it
 * returned swapped for the record behind it.
 */
export class MapperTaint {
  /** Each object the mapper read → the verdict of the key it read it under. */
  private readonly sources = new Map<object, RedactionVerdict>();
  /** Each key the mapper read → the values it read under that name. */
  private readonly byName = new Map<string, unknown[]>();
  /** Each `fields` view handed out → the record behind it and its verdict. */
  private readonly views = new Map<object, { raw: object; verdict: RedactionVerdict }>();
  /** Each record the mapper was handed → as a view (passed on whole, it hands on its selected keys). */
  private readonly records = new Map<object, Record<string, unknown>>();
  /** The selected values the mapper read (whole keys, selected fields) — what it could plant by reference. */
  private readonly secretReads: unknown[] = [];
  private selectedRead = false;
  private open = true;

  private constructor(private readonly rule: RedactionRule) {}

  /** `undefined` while the run's rule is inert — nothing a mapper reads can be selected. */
  static of(rule: RedactionRule | undefined): MapperTaint | undefined {
    return rule !== undefined && !rule.isInert() ? new MapperTaint(rule) : undefined;
  }

  /**
   * The record a mapper is handed: the same own keys and values, each read
   * recorded. An accessor per key, not a Proxy — a mapper may spread, clone or
   * serialize what it is handed. An assignment lands on the view, never on the
   * live record behind it. Anything but a plain record is handed over as it is.
   */
  watch<T>(record: T): T {
    if (!isPlainRecord(record)) return record;
    const view = this.viewOf(record, (key) => this.served(key, record[key]));
    this.records.set(view, record);
    return view as T;
  }

  /**
   * The mapper returned `output`: every key it wrote inherits what it copied
   * (see the class). Returns the output to use — the same object unless a view
   * had to be swapped back for the record behind it.
   */
  inherit<T>(output: T): T {
    this.open = false;
    if (output === null || typeof output !== 'object') return output;
    let out: Record<string, unknown> | undefined;
    for (const [target, value] of Object.entries(output)) {
      const copied = this.copiedVerdict(target, value);
      if (copied === undefined) {
        if (this.selectedRead || this.embedsSelected(value, new WeakSet())) this.rule.mark(target);
      } else if (copied.kind === 'whole') this.rule.mark(target);
      else if (copied.kind === 'fields') this.rule.inheritFields(target, copied.paths);
      const raw = this.behind(value);
      // An object passed on BY REFERENCE may carry what the mapper planted in it
      // (`Object.assign(p.request, { auth: p.token })`, `p.list.push(p.token)`):
      // each place it holds a selected value the mapper read is a field of the new key.
      if (copied !== undefined && copied.kind !== 'whole' && raw !== null && typeof raw === 'object') {
        const planted = this.plantedPaths(raw);
        if (planted.length > 0) this.rule.inheritFields(target, planted);
      }
      if (raw !== value) {
        out ??= (Array.isArray(output) ? [...output] : { ...output }) as Record<string, unknown>;
        out[target] = raw;
      }
    }
    return (out ?? output) as T;
  }

  /** What one recorded read hands the mapper (see the class). */
  private served(key: string, value: unknown): unknown {
    if (!this.open) return value;
    const read = this.byName.get(key);
    if (read === undefined) this.byName.set(key, [value]);
    else read.push(value);
    const verdict = this.rule.verdictOfRead(key, value);
    // An absent key carries no secret; neither does a value with no fields (a scalar) or none of
    // its selected ones — state retains those as they are too.
    if (value === undefined) return value;
    if (verdict.kind === 'fields') {
      if (value === null || typeof value !== 'object' || !RedactionRule.holdsPaths(value, verdict.paths)) {
        return this.remember(value, verdict);
      }
      if (isPlainRecord(value)) return this.fieldsView(value, verdict);
    }
    if (verdict.kind !== 'clear') {
      this.selectedRead = true;
      if (verdict.kind === 'whole') this.secretReads.push(value);
    }
    return this.remember(value, verdict);
  }

  private remember(value: unknown, verdict: RedactionVerdict): unknown {
    if (value !== null && typeof value === 'object') {
      this.sources.set(value, stricter(this.sources.get(value), verdict));
    }
    return value;
  }

  /** A `fields`-selected record: reading one of its selected fields (or a path's first segment) is a selected read. */
  private fieldsView(record: Record<string, unknown>, verdict: RedactionVerdict & { kind: 'fields' }): object {
    const selected = new Set<string>();
    for (const path of verdict.paths) selected.add(path).add(path.split('.')[0]);
    const view = this.viewOf(record, (key) => {
      if (this.open && selected.has(key)) {
        this.selectedRead = true;
        this.secretReads.push(record[key]);
      }
      return record[key];
    });
    this.views.set(view, { raw: record, verdict });
    return view;
  }

  private viewOf(record: Record<string, unknown>, read: (key: string) => unknown): Record<string, unknown> {
    const view: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      Object.defineProperty(view, key, {
        enumerable: true,
        configurable: true,
        get: () => read(key),
        set: (value: unknown) => {
          Object.defineProperty(view, key, { value, writable: true, enumerable: true, configurable: true });
        },
      });
    }
    return view;
  }

  /** The record behind a view the mapper returned; any other value as it is. */
  private behind(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value;
    return this.views.get(value)?.raw ?? this.records.get(value) ?? value;
  }

  /**
   * The verdict `target` inherits from `value` — `undefined` when it is
   * neither a value the mapper read nor one passed under its own name.
   */
  private copiedVerdict(target: string, value: unknown): RedactionVerdict | undefined {
    if (value !== null && typeof value === 'object') {
      const view = this.views.get(value);
      if (view) return view.verdict;
      const record = this.records.get(value);
      if (record) return this.selectedFieldsOf(record);
      const known = this.sources.get(value);
      if (known) return known;
    }
    const read = this.byName.get(target);
    return read?.some((v) => Object.is(v, value)) ? this.rule.verdictOfRead(target, value) : undefined;
  }

  /** A whole record's selected keys, as fields of whatever key it is passed on under. */
  private selectedFieldsOf(record: Record<string, unknown>): RedactionVerdict {
    const paths: string[] = [];
    for (const key of Object.keys(record)) {
      const verdict = this.rule.verdictOfRead(key, record[key]);
      if (verdict.kind === 'whole') paths.push(key);
      else if (verdict.kind === 'fields') for (const path of verdict.paths) paths.push(`${key}.${path}`);
    }
    return paths.length === 0 ? CLEAR : { kind: 'fields', key: '', paths };
  }

  /**
   * Where `root` (an object the mapper passed on by reference) holds one of the
   * selected PRIMITIVES it read — matched by value, only against what this
   * mapper read and only inside what it passed on, so over-matching an equal
   * value is the safe side. One relative path per place, a shared object at
   * each of its paths; a cycle edge is not followed.
   */
  private plantedPaths(root: object): string[] {
    const secrets = new Set<unknown>();
    const collect = (value: unknown, seen: Set<object>): void => {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') secrets.add(value);
      else if (value !== null && typeof value === 'object' && !seen.has(value)) {
        seen.add(value);
        for (const child of Object.values(value)) collect(child, seen);
      }
    };
    for (const value of this.secretReads) collect(value, new Set());
    if (secrets.size === 0) return [];
    const memo = new Map<object, string[]>();
    const onPath = new Set<object>();
    const inside = (node: object): string[] => {
      const known = memo.get(node);
      if (known !== undefined) return known;
      if (onPath.has(node)) return [];
      onPath.add(node);
      const found: string[] = [];
      for (const [key, child] of Object.entries(node)) {
        if (child !== null && typeof child === 'object') for (const sub of inside(child)) found.push(`${key}.${sub}`);
        else if (secrets.has(child)) found.push(key);
      }
      onPath.delete(node);
      memo.set(node, found);
      return found;
    };
    return inside(root);
  }

  /** Does a value the mapper BUILT embed, by reference, a selected record it read or was handed? */
  private embedsSelected(value: unknown, seen: WeakSet<object>): boolean {
    if (value === null || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    if (this.views.has(value)) return true;
    const record = this.records.get(value);
    if (record) return this.selectedFieldsOf(record).kind !== 'clear';
    const known = this.sources.get(value);
    if (known !== undefined && known.kind !== 'clear') return true;
    for (const child of Object.values(value)) if (this.embedsSelected(child, seen)) return true;
    return false;
  }
}
