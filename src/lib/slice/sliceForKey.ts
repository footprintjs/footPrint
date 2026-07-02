/**
 * slice/sliceForKey.ts — the variable-first backward slice query.
 *
 * "Why is `key` what it is?" — the ONE question every triage surface asks:
 * a human clicking a key in explainable-ui, an LLM calling a `backtrack`
 * tool mid-conversation, an offline autopsy agent over a stored run.
 *
 * WHY this is deliberately a composition and not a new algorithm:
 * `findLastWriter` already answers "who made the value what it is" and
 * `causalChain` already answers "what influenced that step" (thin backward
 * slicing, Weiser 1984). What was missing is the shared CONTRACT — without
 * it, every surface hand-rolls the anchor step differently and their answers
 * disagree. The value of this function is that they can't.
 */

import { type CausalChainOptions, type KeysReadLookup, causalChain } from '../memory/backtrack.js';
import { findLastWriter } from '../memory/commitLogUtils.js';
import type { CommitBundle } from '../memory/types.js';
import { normalisePath } from '../memory/utils.js';
import { resolveKeysReadSource } from './keysReadSources.js';
import type { KeysReadSource, StateKey, VariableSlice } from './types.js';

/**
 * Normalise a consumer-facing {@link StateKey} to the engine's canonical
 * string form (the `TraceEntry.path` space). Path arrays go through the same
 * normaliser the engine writes with — the delimiter never leaks into the
 * public contract.
 */
export function normaliseStateKey(key: StateKey): string {
  return typeof key === 'string' ? key : normalisePath([...key]);
}

/** Options for {@link sliceForKey} — causalChain's options plus anchoring. */
export interface SliceForKeyOptions extends CausalChainOptions {
  /**
   * Exclusive commit-array-index upper bound: slice the value as it stood
   * BEFORE this idx (time-travel triage — "why was it X at step 12?").
   * Same contract as `findLastWriter`'s `beforeIdx`. Omit for the current
   * value. Chained-triage idiom: to slice at an {@link ElementBirth}, pass
   * `before: birth.commitIdx + 1` (birth idx is inclusive, this bound is
   * exclusive — the +1 makes the birth commit itself the anchor).
   */
  before?: number;
}

/**
 * Backward slice for one state key: anchor at the key's last writer, then
 * walk read→write (and optional control) dependencies transitively.
 *
 * Honest-absence contract: a missing slice is a RESULT, not an error —
 * `missing: 'never-written'` tells a triage tool (or its LLM caller) that
 * the value came from initial state / frozen args / a closure, which is
 * itself diagnostic information. See {@link VariableSlice} — including its
 * SERIALIZATION WARNING before you stringify the result.
 */
export function sliceForKey(
  commitLog: CommitBundle[],
  key: StateKey,
  keysRead: KeysReadSource | KeysReadLookup,
  options?: SliceForKeyOptions,
): VariableSlice {
  const source = resolveKeysReadSource(keysRead);
  const normalisedKey = normaliseStateKey(key);
  const base: Pick<VariableSlice, 'key' | 'before' | 'keysReadKind' | 'readsCoverage'> = {
    key: normalisedKey,
    ...(options?.before !== undefined && { before: options.before }),
    keysReadKind: source.kind,
    ...(source.coverage !== undefined && { readsCoverage: source.coverage }),
  };

  if (commitLog.length === 0) return { ...base, missing: 'empty-log' };

  const writer = findLastWriter(commitLog, normalisedKey, options?.before);
  if (!writer) return { ...base, missing: 'never-written' };

  // INVARIANT: `writer` came FROM this commitLog, so its runtimeStageId is
  // always present in causalChain's index — causalChain cannot return
  // undefined here (it only does for ids absent from the log). The non-null
  // assertion keeps the VariableSlice contract airtight: `missing` is the
  // ONLY absent-root state. Options pass straight through (controlDeps /
  // weigh / maxDepth / maxNodes keep their causalChain semantics).
  //
  // edgeAttribution defaults to 'per-write' HERE (unlike causalChain's
  // 'stage' default): a variable-first slice knows exactly which written key
  // anchors the question, and per-write attribution is strictly-safe — logs
  // without `TraceEntry.readKeys` (the writeProvenance dial off) fall back
  // to stage-level expansion per node, byte-identically. Consumers can force
  // 'stage' via options.
  const root = causalChain(commitLog, writer.runtimeStageId, source.lookup, {
    ...options,
    edgeAttribution: options?.edgeAttribution ?? 'per-write',
    rootLinkKeys: options?.rootLinkKeys ?? [normalisedKey],
  })!;
  return { ...base, writer, root };
}
