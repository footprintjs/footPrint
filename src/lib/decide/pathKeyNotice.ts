/**
 * decide/pathKeyNotice -- the dev-mode warning for a rule key that looks like a path and names nothing.
 *
 * WHY. A filter rule's key is a top-level state name; a path is not followed. A fork's children write under
 * `runs/<child id>/`, so after a fork the natural rule `{ 'runs.look-tag.tagExists': { eq: true } }` reads a key
 * the state does not hold, can never match, and the decision falls to the default without a word. This module
 * says so, in dev mode only, once per key per run.
 *
 * It lives here and not in `filter/evaluator.ts`: that law is shared with the attempt rule table, whose rows are
 * not state keys, and only `decide()`/`select()` have a scope. It adds no read: it watches the ONE read the
 * evaluator already makes for each condition, so what is recorded, decided and told is what it was.
 *
 * "Names nothing" is the facade's own meaning of a missing key (`ScopeFacade · hasKey`): the read answers
 * `undefined`. A key that has a dot and IS a state key (`scope.$setValue('a.b', 1)`) answers its value, so it is
 * never reported.
 *
 * ```ts
 * const read = watchPathKeys(valueFn, (key) => console.warn(pathKeyMessage(key, 0, 'tag exists')));
 * read('runs.look-tag.tagExists'); // undefined: warns. read('version') never does.
 * ```
 */

/**
 * Wraps `readKey` so that a read of a dotted key that answers `undefined` is reported to `onMissing`. The value
 * returned is always the one `readKey` gave, read once, with the same argument.
 */
export function watchPathKeys(
  readKey: (key: string) => unknown,
  onMissing: (key: string) => void,
): (key: string) => unknown {
  return (key) => {
    const value = readKey(key);
    if (value === undefined && key.includes('.')) onMissing(key);
    return value;
  };
}

/** The warning's text. `label` is the rule's own author text, as the other `decide()` warnings quote it. */
export function pathKeyMessage(key: string, ruleIndex: number, label: string | undefined): string {
  const which = label ? `rule ${ruleIndex}, '${label}'` : `rule ${ruleIndex}`;
  return (
    `[footprint] decide()/select() filter: the key "${key}" (${which}) looks like a path, but rule keys are ` +
    'top-level state names and a path is not followed, and the state holds no key of that name, so this ' +
    'condition can never match. Lift the value to a top-level key in a stage before the decision (a small stage ' +
    `after the fork: scope.name = ...), or use a function rule that reads the path (when: (s) => s.$read('${key}') === true).`
  );
}
