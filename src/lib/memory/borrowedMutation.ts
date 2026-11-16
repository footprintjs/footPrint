/**
 * memory/borrowedMutation — the honest boundary's two texts: the dev-mode
 * REPORT for a write the engine cannot see ({@link borrowedMutationMessage})
 * and the REFUSAL for a write from a handle held past its stage
 * ({@link deadFrameMessage}, thrown by `ScopeFacade · assertLive`).
 *
 * ── The honest boundary ──────────────────────────────────────────────────
 * The typed scope intercepts every write it can reach: a property at any
 * depth, an indexed element, an array method. What it cannot reach is an
 * element handed out by a READ METHOD — `find`, `filter`, `for…of`, `forEach`,
 * destructuring — because wrapping those would mean returning proxies out of
 * every read (`map` would build an array of proxies, `filter` would compare
 * proxies, a returned value would escape the stage still bound to it). That is
 * a cost the library should not pay, and a semantic change it should not make.
 *
 * So the answer for that family is not interception — it is a REPORT. A read
 * is BORROWED; mutating it in place is out of contract. This module detects the
 * violation after the fact and names it (a dev-mode warning at commit — the
 * write already happened, so it cannot be refused), instead of letting the run
 * end with a commit log that disagrees with final state and nothing saying so.
 *
 * ── How ──────────────────────────────────────────────────────────────────
 * `readTracking: 'full'` (the default) already retains a CLONE of every value
 * a stage read. At commit, a key the stage read but never WROTE must still
 * hold what it held at read time — committed state is immutable-after-swap and
 * the buffer's working copy is private. If it differs, the only thing that can
 * have changed it is the stage itself, in place.
 *
 * Dev-mode only (`enableDevMode()`), so the default run pays nothing and its
 * bytes are unchanged.
 */

import { deepEqual } from 'foottrace';
import type { RecordFrame } from 'foottrace/write';

import type { RedactionRule } from './redaction.js';
import { activeRule } from './retainedValue/index.js';

/** Render one path segment for a human: `lines[0].qty`, not `lines.0.qty`. */
function joinSegment(prefix: string, segment: string, intoArray: boolean): string {
  if (intoArray) return `${prefix}[${segment}]`;
  return prefix === '' ? segment : `${prefix}.${segment}`;
}

/**
 * The first path at which `after` stops agreeing with `before`, or `undefined`
 * when they are structurally equal. Depth-first, own keys only — the same
 * shapes `deepEqual` handles, since committed state is JSON-shaped.
 *
 * Cycle-safe by construction: it only recurses into pairs that are not already
 * `deepEqual`, and stops at the first disagreement.
 */
export function firstDifferingPath(before: unknown, after: unknown, prefix = '', depth = 0): string | undefined {
  if (deepEqual(before, after, 'copies')) return undefined;
  if (depth >= 24) return prefix; // pathological nesting — name what we have
  if (before === null || after === null || typeof before !== 'object' || typeof after !== 'object') return prefix;

  const beforeIsArray = Array.isArray(before);
  if (beforeIsArray !== Array.isArray(after)) return prefix;

  if (beforeIsArray) {
    const a = before as unknown[];
    const b = after as unknown[];
    if (a.length !== b.length) return prefix;
    for (let i = 0; i < a.length; i++) {
      const deeper = firstDifferingPath(a[i], b[i], joinSegment(prefix, String(i), true), depth + 1);
      if (deeper !== undefined) return deeper;
    }
    return prefix;
  }

  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const deeper = firstDifferingPath(a[key], b[key], joinSegment(prefix, key, false), depth + 1);
    if (deeper !== undefined) return deeper;
  }
  return prefix;
}

/**
 * The refusal text for a write that reached a frame AFTER its stage committed.
 * A scope, and every proxy read out of it, is bound to the stage it was handed
 * to; kept past that stage's commit it has no frame to land in, so the write
 * would sit in a buffer nothing ever commits — no trace row, state unchanged.
 * The throw surfaces in the stage that made the write (the engine's error
 * path names it); this text names the stage the handle came from.
 */
export function deadFrameMessage(stageName: string, runtimeStageId: string | undefined, key: string): string {
  const from = runtimeStageId ? `"${stageName}" (${runtimeStageId})` : `"${stageName}"`;
  return (
    `[footprint] Stage ${from} has already committed — its scope is dead, and a write to \`${key}\` ` +
    'just reached it from a later stage (this error is raised in that stage). A scope, and anything read ' +
    'out of it (`scope.k`, `scope.k.arr[0]`), belongs to the stage it was handed to; held past that ' +
    "stage's commit it has no frame to land in, so the write would vanish with no trace row. " +
    "Read the key again through the CURRENT stage's scope and write there."
  );
}

/**
 * The refusal raised in an attempt that has ENDED (P1b) — timed out, aborted or
 * failed — when the function behind it touches its scope anyway. The engine
 * stopped waiting for it; whatever it does now would land beside a later
 * attempt (or after the stage's commit), so it is refused. A write or emit is
 * recorded on the stage (`StageSnapshot.lateWrites`) before this is thrown.
 */
export function lateAttemptMessage(stageName: string, series: string, attempt: number, key: string): string {
  return (
    `[footprint] Stage "${stageName}" (${series}): attempt ${attempt} has already ended, and \`${key}\` was ` +
    'touched through its scope afterwards — refused. The engine stopped waiting for this attempt (its cap, the ' +
    "run's deadline, a cancellation, or its own error); its work must not land beside a later attempt. Pass " +
    '`scope.$attempt().signal` to the calls it makes, so they stop when the attempt does.'
  );
}

/**
 * The warning text for a key the stage WROTE after changing, in place, the
 * committed value it had read before its first write (copy-on-write, 9.29.0).
 * The commit compares what the stage wrote against committed state — the
 * object the in-place change also moved — so it records no change: live state
 * keeps the edit, the log and every fold do not. (9.28.0 recorded it when the
 * edit came after the first write, by accident of a whole-state clone.)
 */
export function committedMutationMessage(stageName: string, key: string, path: string): string {
  const where = path === '' ? key : `${key}.${path}`.replace(/\.\[/g, '[');
  return (
    `[footprint] Stage "${stageName}" changed \`${where}\` IN PLACE on the committed value it read before ` +
    'its first write, then wrote the key. The commit compares the written value with committed state — ' +
    'which the in-place change also moved — so it records NO change: live state keeps the edit, the commit ' +
    'log and every reader that folds it do not. Reads are BORROWED. Build the next value instead ' +
    `(\`scope.$setValue('${key}', { ...value, … })\`), or read the key again after the stage's first ` +
    "write — that read is the stage's own copy."
  );
}

/**
 * The warning text for a SUBFLOW MAPPER that changed, in place, a value of the parent's state it was
 * handed (`engine/handlers/mapperEdits.ts`). Its own text, because the way out is another one: a
 * mapper has no scope to write through. What an `outputMapper` returns is the write.
 *
 * WHY THE ADVICE DEPENDS ON THE VALUE. What is handed back is not simply stored
 * (`engine/handlers/SubflowInputMapper.ts · applyOutputMapping`): a list is ADDED to the list that is
 * there, and an object is MERGED into the one that is there, for the object itself and the objects
 * directly inside it; anything deeper is replaced. The first text said "return the new value": for a
 * list that doubled it (`[1, 1, 2]`). The second gave one sentence for every shape: followed for a
 * change three levels down, it dropped the sibling fields there. Both were found by the second reader
 * by following the advice. So the text speaks to the kind of value that was changed, says what it
 * cannot do, and names the guide that has the whole rule. A third kind came from the third read: a
 * `Map`, a `Set`, a `Date` or a class instance is not merged at all, it replaces what is there.
 *
 * `path` is `undefined` when the run has a redaction rule: then the key is named and the place is not.
 */
export function mapperMutationMessage(
  mountName: string,
  mapper: 'inputMapper' | 'outputMapper',
  key: string,
  path: string | undefined,
  holds: 'list' | 'object' | 'other',
): string {
  // No path: the run has a redaction rule, and a place inside a value is part of that value.
  const where = path === undefined || path === '' ? key : `${key}.${path}`.replace(/\.\[/g, '[');
  const hidden = path === undefined ? ' (where inside it is not shown: this run has a redaction rule)' : '';
  const how =
    holds === 'list'
      ? 'A list handed back is ADDED to the list that is there, so return only the new items ' +
        `(\`({ ${key}: [item] })\`), or set \`arrayMerge: ArrayMergeMode.Replace\` on the mount ` +
        "(the enum is on 'footprintjs/advanced') and return the whole list. "
      : holds === 'object'
      ? `An object handed back is MERGED into the one that is there (\`({ ${key}: { field: value } })\`), ` +
        'for the object itself and the objects directly inside it. A list inside it is added to, and ' +
        'anything deeper is replaced, so return such a value whole. '
      : 'A value of this kind (a Map, a Set, a Date, a class instance) is not merged: what is handed back ' +
        `REPLACES the one that is there, so return the whole new value (\`({ ${key}: next })\`). `;
  return (
    `[footprint] Subflow mount "${mountName}": its ${mapper} changed \`${where}\` IN PLACE${hidden}, on the ` +
    "parent's state it was handed. footprint never saw that write: there is no trace row for it, so the " +
    'commit log, the causal chain and every reader that folds the log will disagree with final state. ' +
    "A mapper only reads. To change the parent's state, return the change from the outputMapper: it is " +
    `written as a recorded write. ${how}` +
    'Nothing can be removed that way: use a stage after the mount. ' +
    'See docs/guides/patterns.md ("Input/Output Mapping").'
  );
}

/**
 * The warning text. Names the stage, the exact path that moved, and the two
 * ways to write it back — because "you mutated something" is not actionable
 * and this is the one failure mode the whole design exists to prevent.
 */
export function borrowedMutationMessage(stageName: string, key: string, path: string): string {
  const where = path === '' ? key : `${key}.${path}`.replace(/\.\[/g, '[');
  return (
    `[footprint] Stage "${stageName}" changed \`${where}\` IN PLACE, on a value it only read. ` +
    'footprint never saw that write: there is no trace row for it, so the commit log, the causal chain ' +
    'and every reader that folds the log will disagree with final state — and under a different write ' +
    'order the change is dropped entirely. Reads are BORROWED. ' +
    'Write through the scope instead (`scope.' +
    where +
    ' = …` — property and indexed access are both tracked), ' +
    `or hand back the whole value with \`scope.$setValue('${key}', next)\`. ` +
    'This usually comes from mutating an element reached by `find`/`filter`/`for…of`/`forEach`, ' +
    'which the scope proxy cannot intercept.'
  );
}

interface BorrowedReadView {
  readonly rule: RedactionRule | undefined;
  readonly reads: Record<string, unknown>;
  readonly writes: Record<string, unknown>;
  readonly nested: Set<string> | undefined;
  readonly live: Set<string> | undefined;
  readonly viewReads: Set<string> | undefined;
  readonly record: Pick<RecordFrame, 'at' | 'wasStaged' | 'peek' | 'baseAt'>;
  readonly stageName: string;
}

/**
 * Dev-mode only: did this stage change, IN PLACE, a value it merely READ?
 *
 * The typed scope intercepts every write it can reach — a property at any
 * depth, an indexed element, an array method. What it cannot reach is an
 * element handed out by a read method (`find`, `filter`, `for…of`,
 * `forEach`, destructuring): wrapping those would mean returning proxies out
 * of every read, which is a cost the library should not pay. So that family
 * is WARNED ABOUT rather than intercepted — loudly, here, instead of ending
 * the run with a commit log that silently disagrees with final state.
 *
 * This is a REPORT after the fact, not a refusal at the write: the write has
 * already happened in place and there is nothing to intercept. It runs under
 * TWO preconditions, both named in the README — `enableDevMode()`, and
 * `readTracking: 'full'` (the default), because the comparison needs the
 * clone of the value that mode retains at read time. A key the stage never
 * staged must still hold that clone — committed state is immutable-after-swap
 * and the buffer's working copy is private to this stage. Keys the stage DID
 * stage are skipped (they are expected to differ, and they are in the record),
 * so are keys under a redaction verdict, whose retained form is deliberately
 * not the value, and so are keys read at a nested path (`_nestedReads`) —
 * those are engine reads (the subflow merge-back), not user reads.
 *
 * It also only looks at keys served from the PINNED source — the first-touch
 * view or this stage's own buffer. A key absent from both was served by the
 * read's live fallback (`RecordFrame · read`, tier 2), which a parallel sibling's root-key commit can
 * legitimately move; accusing the stage there would be a false alarm. For
 * the same reason it runs on the frame's FIRST commit only: the reads belong
 * to that round, and by the engine's second round (a fork double-commit, a
 * subflow merge-back into a committed branch parent) other stages have
 * legitimately moved the state they were compared against.
 *
 * A key the stage DID stage is still checked when its last read came from
 * committed state ({@link _viewReads} — read before the first write):
 * that read was the committed object itself, and the buffer's diff base IS
 * that object (copy-on-write, 9.29.0), so an in-place edit followed by a
 * write of the key commits NO change — live state keeps the edit, the log
 * does not. Compared against committed state, not the written value, so a
 * legitimate write never trips it.
 *
 * Costs nothing outside `enableDevMode()`.
 */
export function warnOnBorrowedMutation(view: BorrowedReadView): void {
  const rule = activeRule(view.rule);
  for (const key of Object.keys(view.reads)) {
    const retained = view.reads[key];
    // Only a container can be mutated in place; a primitive read cannot.
    if (retained === null || typeof retained !== 'object') continue;
    if (view.nested?.has(key) || view.live?.has(key)) continue;
    if (rule !== undefined && rule.verdictAt([], key).kind !== 'clear') continue;
    const namespaced = view.record.at([], key);
    if (Object.prototype.hasOwnProperty.call(view.writes, key) || view.record.wasStaged(namespaced)) {
      warnOnCommittedMutation(view, key, namespaced, retained);
      continue;
    }

    // The pinned source only — see the note on the live fallback above.
    // `peek`, not `get`: a report compares, and must not take the private
    // copy a stage's read would (copy-on-write, 9.29.0).
    const current = view.record.peek(namespaced);
    if (current === undefined) continue;

    const path = firstDifferingPath(retained, current);
    if (path === undefined) continue;
    // eslint-disable-next-line no-console
    console.warn(borrowedMutationMessage(view.stageName, key, path));
  }
}

/** The staged-key half of {@link warnOnBorrowedMutation}: did committed state itself move under a read? */
function warnOnCommittedMutation(view: BorrowedReadView, key: string, namespaced: string[], retained: unknown): void {
  if (!view.viewReads?.has(key)) return;
  const committed = view.record.baseAt(namespaced);
  if (committed === undefined) return;
  const path = firstDifferingPath(retained, committed);
  if (path === undefined) return;
  // eslint-disable-next-line no-console
  console.warn(committedMutationMessage(view.stageName, key, path));
}
