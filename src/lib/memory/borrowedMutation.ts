/**
 * memory/borrowedMutation — the honest boundary's two texts: the dev-mode
 * REPORT for a write the engine cannot see ({@link borrowedMutationMessage})
 * and the REFUSAL for a write from a handle held past its stage
 * ({@link deadFrameMessage}, thrown by `StageContext.stageWrite`).
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

import { deepEqual } from './utils.js';

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
  if (deepEqual(before, after)) return undefined;
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
