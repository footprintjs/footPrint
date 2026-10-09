/**
 * scrub.ts — the commit log's scrub: the placeholder at every redacted path of a patch (C4, L2).
 *
 * The RECORD's half of a redaction. A redacted path is DATA by the time it reaches here — the
 * transaction buffer's `redactedPaths`, registered by `RecordFrame · write` from the scrub it was
 * handed — and this file only writes `LOG_PLACEHOLDER` (`placeholders.ts`) where such a path holds
 * a value. It never decides WHAT is secret: that is the engine's verdict (`redaction.ts`, L4 —
 * `RedactionRule` and the write decision), which also owns the OTHER placeholder, the scope channel's
 * `SCOPE_PLACEHOLDER`. Before C4 both halves lived in `redaction.ts`, so the record imported the
 * engine's policy module to write a string.
 *
 * THE LAW:
 *   1. A path is scrubbed only where it holds a DEFINED value — scrubbing never invents a field.
 *   2. Paths are scrubbed in the set's order, against the tree as scrubbed so far: a path under one
 *      already scrubbed finds a string, not a container, and is left alone.
 *   3. The input patch is never edited. `scrubPatch` copies only the spine of each scrubbed path
 *      (and nothing at all when nothing is scrubbed); `redactPatch` hands back a fresh deep copy.
 */

import { nativeGet, nativeHas, nativeSet, ownedRootOf, ownSpine } from './pathOps.js';
import { DELIM } from './paths.js';
import { LOG_PLACEHOLDER } from './placeholders.js';
import type { MemoryPatch } from './types.js';

/**
 * The commit log's scrub: `patch` with {@link LOG_PLACEHOLDER} at every path in `redactedPaths` that
 * holds a defined value — the copy `recordCommit` records and feeds the redacted mirror.
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
 * and never edits it. (It lived in `memory/utils.ts` until 9.33.0 and in `memory/redaction.ts` until
 * C4; the engine's own commit path uses the clone-free {@link scrubPatch}.)
 */
export function redactPatch(patch: MemoryPatch, redactedSet: Set<string>): MemoryPatch {
  return scrubPatch(structuredClone(patch), redactedSet);
}
