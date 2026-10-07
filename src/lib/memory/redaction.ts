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
 *   - a subflow mapper's copy — a key an `inputMapper`/`outputMapper` wrote
 *     inherits the redaction of the selected value it copied ({@link MapperTaint}).
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
 * TWO PLACEHOLDERS, BOTH HISTORICAL: the commit log and the mirror carry
 * `'REDACTED'` (`scrubPatch` / `redactPatch`, below — the strings unchanged since 4.x); every scope-tier view —
 * scope recorder events, `stageReads`/`stageWrites`, narrative — carries
 * `'[REDACTED]'`. Neither string changed in 9.19.0. The strings themselves are
 * owned by `memory/placeholders.ts` (`LOG_PLACEHOLDER` / `SCOPE_PLACEHOLDER`)
 * and spelled nowhere else in `src/` — this rule asks for the scope one by name.
 */

import { isDevMode } from '../devMode.js';
import type { StructuredErrorInfo } from '../errors/errorInfo.js';
import { extractErrorInfo, thrownText } from '../errors/errorInfo.js';
import { nativeGet, nativeHas, nativeSet, ownedRootOf, ownSpine } from './pathOps.js';
import { DELIM } from './paths.js';
import { LOG_PLACEHOLDER, SCOPE_PLACEHOLDER } from './placeholders.js';
import type { MemoryPatch } from './types.js';

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
 * Maximum key length (characters) that will be tested against regex redaction
 * patterns. Keys longer than this are skipped for pattern matching to prevent
 * ReDoS: a pathological regex tested against an unboundedly long key string
 * can cause catastrophic backtracking. 256 characters comfortably exceeds any
 * realistic scope-state key name.
 */
const MAX_PATTERN_KEY_LEN = 256;

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
    return servedByPath(kept, path.join('.'), [], this.namesWalk(false), SCOPE_PLACEHOLDER);
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
      return selectsByPath(value, undefined, [], this.namesWalk(false), new Set(), 0);
    } catch {
      return true;
    }
  }

  /**
   * The key-level rules as the path walk asks them ({@link servedByPath}): a
   * nested key is selected by its own name or its dotted path, and a declared
   * (or inherited) field below a key of its name is a target. `rootDecided`:
   * the root's own keys were already decided by the caller (`retainRecord`).
   */
  private namesWalk(rootDecided: boolean): Walk {
    return {
      names: {
        masks: (name, path) => this.isKeyRedacted(name) || (path !== name && this.isKeyRedacted(path)),
        fields: (name) => this.fieldsOf(name),
      },
      rootDecided,
      budget: WALK_BUDGET,
    };
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
    const declared = this.policy?.fields?.[key];
    const inherited = this.inherited?.get(key);
    if (inherited === undefined) return declared;
    return declared === undefined ? inherited : [...new Set([...declared, ...inherited])];
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

  /** The verdict of a key a mapper read — `runs` (the run namespaces) is selected when any namespaced key is. */
  verdictOfRead(key: string, value: unknown): RedactionVerdict {
    const verdict = this.verdictOfKey(key);
    if (verdict.kind !== 'clear' || key !== 'runs' || value === null || typeof value !== 'object') return verdict;
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
    return servedByPath(top, undefined, [], this.namesWalk(true), placeholder) as T;
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
      { rootDecided: false, budget: WALK_BUDGET },
      placeholder,
    ) as Record<string, unknown>;
  }

  report(): RedactionReport {
    const fieldRedactions: Record<string, string[]> = {};
    for (const [key, fields] of Object.entries(this.policy?.fields ?? {})) {
      fieldRedactions[key] = [...fields];
    }
    // Fields a mapper handed to a new key are scrubbed under that key too.
    for (const [key, fields] of this.inherited ?? []) {
      fieldRedactions[key] = [...new Set([...(fieldRedactions[key] ?? []), ...fields])];
    }
    return {
      redactedKeys: [...this.marked],
      fieldRedactions,
      patterns: (this.policy?.patterns ?? []).map((p) => p.source),
    };
  }
}

// ─── The path walk — one decision per PATH ─────────────────────────────────
//
// A rule that names a PATH (a dotted key, a pattern, a field) must be exact
// even when one object is reachable at two paths: the decision is made per
// path, never per object, and a copy is made per path (copy-on-write) — never
// a scrub in place on a node another path still shows. The only memory of
// what was visited is the ancestor stack of the CURRENT path, a cycle guard.
// A key-NAME rule is the same at every path, so a shared node it masks is
// masked everywhere — the safe side. Rules are decided along acyclic paths: a
// cycle edge is not followed, it is pointed at the ancestor's served copy.

/** A field still to reach below a node: the path segments left to walk. */
type Target = readonly string[];

/** How a walk decides an edge. */
interface Walk {
  /** Key-level rules at every nested key — absent for a bare field scrub (targets only). */
  readonly names?: {
    /** Selected whole at this nested key: by its own name or its dotted path. */
    masks(name: string, path: string): boolean;
    /** The declared fields below a key of this name. */
    fields(name: string): readonly string[] | undefined;
  };
  /** The root's own keys were decided by the caller (`retainRecord`): walk below them only. */
  readonly rootDecided: boolean;
  /** Path visits left. A DAG's paths can outnumber its objects without bound. */
  budget: number;
}

/**
 * Path visits one walk may make before it gives up and serves its whole value
 * as the placeholder (the safe side) — a bound on a pathological DAG, far above
 * any tree a run holds (a tree's paths are its nodes).
 */
const WALK_BUDGET = 1_000_000;
const BUDGET_SPENT: unique symbol = Symbol('redaction walk budget spent');

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

/** One edge's decision: the value under `key` is masked here, or these targets continue below it. */
function decideEdge(
  key: string,
  path: string,
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
    masked = names.masks(key, path);
    below.push(...targetsOf(names.fields(key)));
  }
  return { masked, below };
}

/** Is anything selected on some PATH under `node`? Read-only; a cycle edge is not followed. */
function selectsByPath(
  node: object,
  dotted: string | undefined,
  targets: readonly Target[],
  walk: Walk,
  ancestors: Set<object>,
  depth: number,
): boolean {
  if (--walk.budget < 0) throw BUDGET_SPENT;
  if (walk.names === undefined && targets.length === 0) return false;
  ancestors.add(node);
  try {
    for (const [key, child] of Object.entries(node)) {
      const path = dotted === undefined ? key : `${dotted}.${key}`;
      const edge = decideEdge(key, path, targets, walk, depth);
      if (edge.masked) return true;
      if (child === null || typeof child !== 'object' || ancestors.has(child)) continue;
      if (selectsByPath(child, path, edge.below, walk, ancestors, depth + 1)) return true;
    }
    return false;
  } finally {
    ancestors.delete(node);
  }
}

/**
 * The served copy of `node`, copy-on-write PER PATH. Every container entered
 * gets its copy BEFORE its children are walked, so a cycle edge is pointed at
 * the ancestor's copy — never back at an unscrubbed original; a container is
 * served as itself when nothing under it changed and no cycle passes through
 * it. A pruned descent (a bare field scrub of an acyclic value) skips subtrees
 * no target reaches. `back` is the shallowest ancestor a cycle edge below
 * reached (`Infinity`: none).
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
): { out: object; back: number } {
  if (--walk.budget < 0) throw BUDGET_SPENT;
  const frame = {
    copy: (Array.isArray(node) ? node.slice() : { ...node }) as Record<string, unknown>,
    depth,
  };
  ancestors.set(node, frame);
  let changed = false;
  let back = Infinity;
  for (const [key, child] of Object.entries(node)) {
    const path = dotted === undefined ? key : `${dotted}.${key}`;
    const edge = decideEdge(key, path, targets, walk, depth);
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
    const below = copyByPath(child, path, edge.below, walk, placeholder, ancestors, depth + 1, prune);
    if (below.out !== child) {
      frame.copy[key] = below.out;
      changed = true;
    }
    back = Math.min(back, below.back);
  }
  ancestors.delete(node);
  return { out: changed || back <= depth ? frame.copy : node, back: back < depth ? back : Infinity };
}

/** Does any path from `root` come back to an object on it? */
function hasCycle(root: object): boolean {
  const done = new WeakSet<object>();
  const onPath = new Set<object>();
  const visit = (node: object): boolean => {
    if (onPath.has(node)) return true;
    if (done.has(node)) return false;
    onPath.add(node);
    for (const child of Object.values(node)) {
      if (child !== null && typeof child === 'object' && visit(child)) return true;
    }
    onPath.delete(node);
    done.add(node);
    return false;
  };
  return visit(root);
}

/**
 * The served form of `root` under a walk: `root` itself when no path selects
 * anything, else its copy-on-write copy; the placeholder when the walk spends
 * its budget (never the raw value). Any other throw — an enumerable getter
 * that throws — propagates: the caller refuses to serve.
 */
function servedByPath(
  root: object,
  dotted: string | undefined,
  targets: readonly Target[],
  walk: Walk,
  placeholder: string,
): unknown {
  try {
    if (!selectsByPath(root, dotted, targets, walk, new Set(), 0)) return root;
    walk.budget = WALK_BUDGET;
    // A bare field scrub of an acyclic value walks its targets only: no cycle can bring an
    // unscrubbed original back. Every other walk visits every path (a cycle edge anywhere
    // must land on a served copy).
    const prune = walk.names === undefined && !hasCycle(root);
    return copyByPath(root, dotted, targets, walk, placeholder, new Map(), 0, prune).out;
  } catch (error) {
    if (error === BUDGET_SPENT) return placeholder;
    throw error;
  }
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
 * inherits the redaction of the SELECTED value it copied, for the rest of the
 * run — a mark (or inherited fields), by name, like a per-call
 * `setValue(key, value, true)` — so the subflow's seed, log, mirror, reads,
 * narrative and results, and the parent's merge-back, retain the copy as they
 * retain its source. Decided by which values the mapper READ:
 *
 *   - EXACT — an output OBJECT that IS (by reference) a value the mapper read
 *     inherits that key's verdict: whole stays whole, `fields` hand their paths
 *     to the new key, clear stays clear. (Values are never matched by EQUALITY:
 *     an equal primitive would over-match unrelated keys.)
 *   - CONSERVATIVE — any other output (a primitive, or an object the mapper
 *     built) is selected WHOLE when the mapper read a selected value — a
 *     whole-selected key, or a selected FIELD of a `fields`-selected record —
 *     or when it embeds such a record by reference; the library cannot tell
 *     what a computed value carries.
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
  /** Each `fields` view handed out → the record behind it and its verdict. */
  private readonly views = new Map<object, { raw: object; verdict: RedactionVerdict }>();
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
    return this.viewOf(record, (key) => this.served(key, record[key])) as T;
  }

  /**
   * The mapper returned `output`: every key it wrote inherits what it copied
   * (see the class). Returns the output to use — the same object unless a
   * `fields` view had to be swapped back for its record.
   */
  inherit<T>(output: T): T {
    this.open = false;
    if (output === null || typeof output !== 'object') return output;
    let out: Record<string, unknown> | undefined;
    for (const [target, value] of Object.entries(output)) {
      const view = value !== null && typeof value === 'object' ? this.views.get(value) : undefined;
      const copied = view ? view.verdict : this.copiedVerdict(value);
      if (copied === undefined) {
        if (this.selectedRead || this.embedsSelected(value, new WeakSet())) this.rule.mark(target);
      } else if (copied.kind === 'whole') this.rule.mark(target);
      else if (copied.kind === 'fields') this.rule.inheritFields(target, copied.paths);
      if (view) {
        out ??= (Array.isArray(output) ? [...output] : { ...output }) as Record<string, unknown>;
        out[target] = view.raw;
      }
    }
    return (out ?? output) as T;
  }

  /** What one recorded read hands the mapper (see the class). */
  private served(key: string, value: unknown): unknown {
    if (!this.open) return value;
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
    if (verdict.kind !== 'clear') this.selectedRead = true;
    return this.remember(value, verdict);
  }

  private remember(value: unknown, verdict: RedactionVerdict): unknown {
    if (value !== null && typeof value === 'object')
      this.sources.set(value, stricter(this.sources.get(value), verdict));
    return value;
  }

  /** A `fields`-selected record: reading one of its selected fields (or a path's first segment) is a selected read. */
  private fieldsView(record: Record<string, unknown>, verdict: RedactionVerdict & { kind: 'fields' }): object {
    const selected = new Set<string>();
    for (const path of verdict.paths) selected.add(path).add(path.split('.')[0]);
    const view = this.viewOf(record, (key) => {
      if (this.open && selected.has(key)) this.selectedRead = true;
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

  /** The verdict an output value inherits by reference — `undefined` when it is no value the mapper read. */
  private copiedVerdict(value: unknown): RedactionVerdict | undefined {
    return value !== null && typeof value === 'object' ? this.sources.get(value) : undefined;
  }

  /** Does a value the mapper BUILT embed, by reference, a selected record it read? */
  private embedsSelected(value: unknown, seen: WeakSet<object>): boolean {
    if (value === null || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    if (this.views.has(value)) return true;
    const known = this.sources.get(value);
    if (known !== undefined && known.kind !== 'clear') return true;
    for (const child of Object.values(value)) if (this.embedsSelected(child, seen)) return true;
    return false;
  }
}

/**
 * The commit log's scrub: `patch` with {@link LOG_PLACEHOLDER} at every path in `redactedPaths` that
 * holds a defined value — the copy `StageContext · commit` records and feeds the redacted mirror.
 *
 * CLONE-FREE (9.33.0). The patch is the transaction buffer's commit-time payload, already the record's
 * own copy (`TransactionBuffer · commit` clones each surviving path once; the buffer is dropped at
 * commit), so the scrub copies only what it must not edit in place:
 *   - no path to scrub (no policy, no per-call mark — the common case) → `patch` ITSELF, no copy at all;
 *   - otherwise → a new root and a shallow copy of each container on a scrubbed path (`pathOps ·
 *     ownSpine`), every other subtree shared with `patch`. `patch` is never edited.
 * The engine called the public {@link redactPatch} (a whole `structuredClone`) twice per commit before
 * 9.33.0. The bytes are the same: a scrubbed path holds the placeholder, every other path the value the
 * buffer cloned (pinned by the 9.18.1 / 9.19.1 redaction byte tests).
 *
 * Paths are scrubbed in the set's order, against the tree as scrubbed so far: a path under one already
 * scrubbed finds a string, not a container, and is left alone (as before).
 *
 * INTERNAL — the result shares structure with `patch`. A caller outside the commit path wants
 * {@link redactPatch}.
 *
 * @param redactedPaths DELIM-joined paths (`TransactionBuffer`'s `redactedPaths`; a bundle's
 *   `redactedPaths` array works too).
 */
export function scrubPatch(patch: MemoryPatch, redactedPaths: Iterable<string>): MemoryPatch {
  let out: MemoryPatch | undefined;
  let owned: WeakSet<object> | undefined;
  for (const flat of redactedPaths) {
    const segs = flat.split(DELIM);
    const current = out ?? patch;
    if (!nativeHas(current, segs) || nativeGet(current, segs) === undefined) continue;
    if (out === undefined) {
      owned = new WeakSet<object>();
      out = ownedRootOf(patch, owned) as MemoryPatch;
    }
    ownSpine(out, segs, owned!);
    nativeSet(out, segs, LOG_PLACEHOLDER);
  }
  return out ?? patch;
}

/**
 * Redacts sensitive values in a patch for logging/debugging — the PUBLIC scrub (`footprintjs/advanced`),
 * its contract unchanged since 4.x: a fresh deep copy of `patch` (`structuredClone`) with
 * {@link LOG_PLACEHOLDER} at every listed path that holds a defined value. Shares nothing with `patch`
 * and never edits it. (Moved here from `memory/utils.ts` in 9.33.0; the engine's own commit path uses the
 * clone-free {@link scrubPatch}.)
 */
export function redactPatch(patch: MemoryPatch, redactedSet: Set<string>): MemoryPatch {
  return scrubPatch(structuredClone(patch), redactedSet);
}
