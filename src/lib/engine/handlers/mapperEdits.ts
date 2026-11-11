/**
 * mapperEdits.ts — development mode: did a subflow mapper change, IN PLACE, a value it was handed?
 *
 * WHY THIS FILE EXISTS. The view a mapper is handed (`mapperScope.ts`) gives out the live committed
 * values of the parent's state. A change inside one (`parent.profile.name = 'x'`,
 * `parent.list.push(1)`) edits committed state itself, and no row of the record says so: the commit
 * log, the causal chain and every reader that folds the log then disagree with final state. The view
 * cannot stop that without wrapping every value it hands out, which is the cost it exists to avoid.
 * So, as for a stage, it is reported.
 *
 * HOW. For ONE mapper call: the first time the mapper reads a root key that holds an object, a copy
 * is taken. When the call is over, each copy is held against the object it was taken from. A
 * difference names the mount, the mapper, the key and the path.
 *
 * WHY PER CALL, AND NOT AT THE MOUNT'S COMMIT. A mapper runs in one go: between its first read and
 * its end no other step runs, so a difference is that mapper's own doing. The first cut of this
 * check judged at the mount's commit, against the copies the frame keeps of its reads, and a mount
 * stays open for the whole run of its subflow. The second reader of that cut broke it three ways:
 *   - a mount that only READ a value was blamed for an edit a parallel sibling made in the meantime;
 *   - an edit was missed when the merge-back's own read replaced the frame's copy with the edited
 *     value (it depended on the order of the keys an `outputMapper` returned);
 *   - an edit was dropped when a sibling replaced the key afterwards.
 * None of the three can happen inside one call. The frame keeps nothing for this check any more.
 *
 * WHAT IT SAYS WHEN THE RUN HAS A REDACTION RULE. The key, never the place inside it. A path is made
 * of the value's own field names and list positions, and those are part of the value: a record keyed
 * by e-mail address would print an address. A rule covers every line the library prints.
 * WHY THE WHOLE RUN, AND NOT "IS THIS KEY SELECTED". A value can be selected in more ways than by its
 * key's name: a rule on a path inside it, a pattern that matches a field name deeper down, a record
 * that carries its rule from another key because it is the same object. Asking a narrower question
 * here would be a second place that has to get all of those right. The automated security review of
 * this check found the first cut printing the path, and the second cut asking the key's verdict
 * alone, each within minutes. So: any rule that selects anything, and the place is not shown.
 *
 * WHAT IT COSTS. Development mode only (`enableDevMode()`): one copy for each object-valued key a
 * mapper reads, per call, dropped when the call ends. It does not depend on `readTracking`: that
 * setting says what the RECORD keeps, and this keeps nothing. Outside development mode nothing is
 * built ({@link watchForEdits} answers `undefined`) and the record's bytes are the same.
 *
 * NOT REPORTED (named here, pinned by tests):
 *   - a value the mapper kept from an earlier call and changed in a later one (a closure that holds
 *     `parent.profile` from the `inputMapper` and edits it in the `outputMapper`): the later call
 *     never read it;
 *   - a value that cannot be copied (it holds a function): there is nothing to hold it against;
 *   - a change made after the call ended, by code the mapper started (a timer, a promise).
 */
import { isDevMode } from '../../devMode.js';
import { firstDifferingPath, mapperMutationMessage } from '../../memory/borrowedMutation.js';

/** Which of a mount's two mappers a view was opened for. */
export type MapperRole = 'inputMapper' | 'outputMapper';

/** The watch over one mapper call. */
export interface MapperEditWatch {
  /** The mapper is about to be handed `value` for the root key `key`. */
  saw(key: string, value: unknown): void;
  /** The call is over: report every value that no longer equals its copy. Does it once. */
  report(): void;
}

/** What the watch asks of the mount: its name, and whether the run has a redaction rule that selects anything. */
export interface WatchedMount {
  readonly stageName: string;
  getPolicy(): { readonly redaction?: { isInert(): boolean } };
}

/**
 * A watch for one call of `mapper` on `mount`, or `undefined` outside development mode: then no copy
 * is taken and nothing is kept.
 */
export function watchForEdits(mount: WatchedMount, mapper: MapperRole): MapperEditWatch | undefined {
  if (!isDevMode()) return undefined;
  // key -> the object the mapper was handed, and that object as it was at that moment.
  let handed: Map<string, { readonly value: object; readonly copy: unknown }> | undefined = new Map();
  return {
    saw(key, value) {
      // Only an object can be changed in place. The FIRST read is the one to hold on to: a read made
      // after the mapper's own edit would copy the edited value and hide the edit.
      if (handed === undefined || value === null || typeof value !== 'object' || handed.has(key)) return;
      try {
        handed.set(key, { value, copy: structuredClone(value) });
      } catch {
        // A value nothing can copy (it holds a function) cannot be judged. It is left out, not guessed at.
      }
    },
    report() {
      if (handed === undefined) return;
      const judged = handed;
      // Released before the first comparison: the watch holds live values for the length of one call only.
      handed = undefined;
      // Asked when the call is over: a key marked as private during the run counts from then on.
      const rule = mount.getPolicy().redaction;
      const nameThePlace = rule === undefined || rule.isInert();
      for (const [key, { value, copy }] of judged) {
        const path = firstDifferingPath(copy, value);
        if (path === undefined) continue;
        // eslint-disable-next-line no-console
        console.warn(mapperMutationMessage(mount.stageName, mapper, key, nameThePlace ? path : undefined));
      }
    },
  };
}
